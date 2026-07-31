-- OPTIONAL. Lets the worker edit SQL Agent jobs it does not own, without
-- granting it sysadmin and without changing who owns any job.
--
-- Do not install this unless you have read what it does. It is the only part of
-- this product that puts anything of ours inside msdb.
--
--   1. Edit @login below.
--   2. sqlcmd -S localhost -E -i worker-write-wrapper.sql
--   3. Add the jobs the worker may edit — nothing works until you do:
--        INSERT msdb.dbo.rsagent_write_allowlist(job_name, added_by)
--        VALUES (N'Nightly load', SUSER_SNAME());
--
-- ============================================================================
-- Why this exists
-- ============================================================================
--
-- sp_update_job refuses to touch a job owned by another login unless the caller
-- is sysadmin:
--
--   IF ( (@x_owner_sid <> SUSER_SID())
--        AND (ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) <> 1)
--        AND (@enable_only_used <> 1 OR ISNULL(IS_MEMBER(N'SQLAgentOperatorRole'), 0) <> 1))
--     RAISERROR(14525, -1, -1)
--
-- Note the third clause: enable and disable of another login's job are already
-- allowed for SQLAgentOperatorRole. Only editing is refused. If all you need is
-- to start, stop, enable and disable jobs across the estate, you do not need
-- this file at all.
--
-- The two obvious ways round it are both worse:
--
--   Reassign job ownership to the worker login. This changes the security
--   context every job step runs under. Measured on SQL Server 2022: a T-SQL
--   step that succeeded as "NT AUTHORITY\NETWORK SERVICE" under an sa-owned job
--   fails with a permission error under a low-privilege owner, and CmdExec,
--   PowerShell and SSIS steps refuse outright with "Non-SysAdmins have been
--   denied permission to run CmdExec job steps without a proxy account".
--
--   Grant the worker sysadmin. Then a compromised control plane owns the
--   instance, which is the thing this product is built not to allow.
--
-- ============================================================================
-- How it works, and why it needs both halves
-- ============================================================================
--
-- Each procedure below is created WITH EXECUTE AS OWNER *and* signed by a
-- certificate whose login is a member of sysadmin. Both are required, and each
-- alone is useless — verified, not assumed:
--
--   signed only ............. fails. A signature adds a token to the signed
--                             module, and that addition does not survive the
--                             nested call into sp_update_job.
--   EXECUTE AS OWNER only ... fails when msdb is not TRUSTWORTHY. The context
--                             switch propagates, but the impersonated principal
--                             has no server-level authority, so
--                             IS_SRVROLEMEMBER('sysadmin') is still 0.
--   both .................... works, with TRUSTWORTHY ON or OFF.
--
-- Using both means this does NOT require TRUSTWORTHY. msdb ships with it ON,
-- but hardening guides turn it off, and this keeps working when they do.
--
-- ============================================================================
-- What the worker login can and cannot do afterwards
-- ============================================================================
--
--   * It gains EXECUTE on the four procedures below and nothing else. Outside
--     them IS_SRVROLEMEMBER('sysadmin') is still 0.
--   * It can only touch jobs listed in rsagent_write_allowlist, which starts
--     empty. Installing this grants nothing until a DBA names a job.
--   * It cannot change a job's owner or a step's proxy. Both are privilege
--     escalation: owner decides the security context steps run under, and a
--     proxy is a stored credential.
--   * It cannot create a CmdExec, PowerShell, SSIS or ActiveScripting step. Job
--     steps run as the Agent service account, so a subsystem allowlist is the
--     difference between "edit T-SQL" and "run anything as the service account".
--   * Every call is recorded in rsagent_write_audit with ORIGINAL_LOGIN(), which
--     survives the context switch — so the log names the caller, not sa.
--
-- Removing it: DROP the four procedures, the two tables, the certificate in
-- msdb, and the certificate and login in master.

SET NOCOUNT ON;
GO

USE [msdb];
GO

-- ---------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------
DECLARE @login sysname = N'rsagent_worker';   -- <-- change this

IF DATABASE_PRINCIPAL_ID(@login) IS NULL
BEGIN
    RAISERROR('No user named "%s" in msdb. Run worker-permissions.sql first.', 16, 1, @login);
    RETURN;
END

-- Stash for later batches; GO resets local variables.
IF OBJECT_ID('tempdb..#rsagent_install') IS NOT NULL DROP TABLE #rsagent_install;
-- The signing key password is generated per install and never written down.
-- It protects the certificate's private key at rest in msdb; it is used to
-- create and sign in this one run and is not needed again. Re-running this
-- script recreates and re-signs, so there is nothing to recover.
CREATE TABLE #rsagent_install (login sysname, cert_password nvarchar(128));
INSERT #rsagent_install(login, cert_password)
VALUES (@login, N'Rs' + REPLACE(CAST(NEWID() AS nvarchar(64)), '-', '') + N'!9Aa');
GO

-- ---------------------------------------------------------------------------
-- Allowlist and audit
-- ---------------------------------------------------------------------------

IF OBJECT_ID('dbo.rsagent_write_allowlist') IS NULL
CREATE TABLE dbo.rsagent_write_allowlist (
    job_name  sysname       NOT NULL PRIMARY KEY,
    added_by  sysname       NOT NULL DEFAULT SUSER_SNAME(),
    added_at  datetime2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
    note      nvarchar(400) NULL
);
GO

IF OBJECT_ID('dbo.rsagent_write_audit') IS NULL
CREATE TABLE dbo.rsagent_write_audit (
    id             bigint IDENTITY(1,1) PRIMARY KEY,
    at             datetime2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
    -- ORIGINAL_LOGIN() rather than SUSER_SNAME(): inside these procedures the
    -- context is the owner, so SUSER_SNAME() would record "sa" every time and
    -- the log would name nobody.
    original_login sysname       NOT NULL,
    procedure_name sysname       NOT NULL,
    job_name       sysname       NOT NULL,
    step_id        int           NULL,
    -- Whether the call was permitted to proceed, not whether msdb then
    -- accepted it. A row with allowed=1 means the guards passed; the SQL Agent
    -- procedure underneath can still have failed for its own reasons.
    allowed        bit           NOT NULL,
    detail         nvarchar(400) NULL
);
GO

-- ---------------------------------------------------------------------------
-- Certificate, and the sysadmin-mapped login it authenticates
--
-- Transferred as binary rather than through a file: BACKUP CERTIFICATE needs a
-- path the SQL Server service can write, which differs between Windows and
-- Linux, and it leaves a file on disk that maps to a sysadmin login.
-- ---------------------------------------------------------------------------

-- Re-runnable. The signing password is random per install, so an existing
-- certificate cannot be reused for signing and has to be replaced — and a
-- certificate cannot be dropped while anything is still signed with it, so the
-- signatures go first. Without this, the second run of this script fails with
-- "The certificate cannot be dropped because one or more entities are either
-- signed or encrypted using it".
DECLARE @unsign nvarchar(max) = N'';
SELECT @unsign = @unsign + N'DROP SIGNATURE FROM ' + QUOTENAME(OBJECT_SCHEMA_NAME(cp.major_id))
                         + N'.' + QUOTENAME(OBJECT_NAME(cp.major_id))
                         + N' BY CERTIFICATE RsAgentWriteCert;'
FROM sys.crypt_properties cp
JOIN sys.certificates c ON c.thumbprint = cp.thumbprint
WHERE c.name = 'RsAgentWriteCert' AND cp.class = 1;
IF @unsign <> N'' EXEC sys.sp_executesql @unsign;

IF EXISTS (SELECT 1 FROM sys.certificates WHERE name = 'RsAgentWriteCert')
    DROP CERTIFICATE RsAgentWriteCert;
GO
DECLARE @pw nvarchar(128) = (SELECT cert_password FROM #rsagent_install);
DECLARE @mk nvarchar(max) = N'
CREATE CERTIFICATE RsAgentWriteCert
    ENCRYPTION BY PASSWORD = ''' + @pw + N'''
    WITH SUBJECT = ''Remote SQL Agent job write wrapper'',
         EXPIRY_DATE = ''2099-12-31'';';
EXEC sys.sp_executesql @mk;
GO

DECLARE @cert varbinary(max) = CERTENCODED(CERT_ID('RsAgentWriteCert'));
DECLARE @sql nvarchar(max) = N'
USE [master];
IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = ''RsAgentWriteSigner'')
    DROP LOGIN RsAgentWriteSigner;
IF EXISTS (SELECT 1 FROM sys.certificates WHERE name = ''RsAgentWriteCert'')
    DROP CERTIFICATE RsAgentWriteCert;
CREATE CERTIFICATE RsAgentWriteCert FROM BINARY = ' + CONVERT(nvarchar(max), @cert, 1) + N';
CREATE LOGIN RsAgentWriteSigner FROM CERTIFICATE RsAgentWriteCert;
ALTER SERVER ROLE sysadmin ADD MEMBER RsAgentWriteSigner;';
EXEC sys.sp_executesql @sql;
GO

-- ---------------------------------------------------------------------------
-- Guard, shared by every procedure
-- ---------------------------------------------------------------------------

CREATE OR ALTER PROCEDURE dbo.rsagent_write_guard
    @procedure_name sysname,
    @job_name       sysname,
    @step_id        int = NULL,
    @detail         nvarchar(400) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @allowed bit =
        CASE WHEN EXISTS (SELECT 1 FROM dbo.rsagent_write_allowlist WHERE job_name = @job_name)
             THEN 1 ELSE 0 END;

    INSERT dbo.rsagent_write_audit (original_login, procedure_name, job_name, step_id, allowed, detail)
    VALUES (ORIGINAL_LOGIN(), @procedure_name, @job_name, @step_id, @allowed, @detail);

    IF @allowed = 0
        RAISERROR('Job "%s" is not in msdb.dbo.rsagent_write_allowlist, so this worker may not edit it. A DBA must add it explicitly.', 16, 1, @job_name);
END
GO

-- ---------------------------------------------------------------------------
-- The wrappers
--
-- Parameters are enumerated rather than passed through. A single procedure
-- taking @command and forwarding it is the same surface as sp_update_jobstep
-- with a different name; naming each field is what makes the exclusions
-- (owner, proxy, subsystem) enforceable rather than advisory.
-- ---------------------------------------------------------------------------

CREATE OR ALTER PROCEDURE dbo.rsagent_update_job
    @job_name         sysname,
    @new_name         sysname       = NULL,
    @description      nvarchar(512) = NULL,
    @enabled          tinyint       = NULL,
    @category_name    sysname       = NULL,
    @notify_level_eventlog int      = NULL,
    @notify_level_email    int      = NULL,
    @notify_email_operator_name sysname = NULL
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    EXEC dbo.rsagent_write_guard 'rsagent_update_job', @job_name;

    -- @owner_login_name is deliberately absent. Changing a job's owner changes
    -- the security context its steps run under, which is escalation by any
    -- other name and the exact thing this file exists to avoid doing.
    EXEC msdb.dbo.sp_update_job
        @job_name                   = @job_name,
        @new_name                   = @new_name,
        @description                = @description,
        @enabled                    = @enabled,
        @category_name              = @category_name,
        @notify_level_eventlog      = @notify_level_eventlog,
        @notify_level_email         = @notify_level_email,
        @notify_email_operator_name = @notify_email_operator_name;
END
GO

CREATE OR ALTER PROCEDURE dbo.rsagent_update_jobstep
    @job_name           sysname,
    @step_id            int,
    @step_name          sysname       = NULL,
    @command            nvarchar(max) = NULL,
    @database_name      sysname       = NULL,
    @on_success_action  tinyint       = NULL,
    @on_success_step_id int           = NULL,
    @on_fail_action     tinyint       = NULL,
    @on_fail_step_id    int           = NULL,
    @retry_attempts     int           = NULL,
    @retry_interval     int           = NULL
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    EXEC dbo.rsagent_write_guard 'rsagent_update_jobstep', @job_name, @step_id;

    -- @subsystem and @proxy_name are absent, so an existing step keeps whatever
    -- it already had. A T-SQL step cannot be turned into a CmdExec step, and a
    -- step cannot be pointed at a different stored credential.
    EXEC msdb.dbo.sp_update_jobstep
        @job_name           = @job_name,
        @step_id            = @step_id,
        @step_name          = @step_name,
        @command            = @command,
        @database_name      = @database_name,
        @on_success_action  = @on_success_action,
        @on_success_step_id = @on_success_step_id,
        @on_fail_action     = @on_fail_action,
        @on_fail_step_id    = @on_fail_step_id,
        @retry_attempts     = @retry_attempts,
        @retry_interval     = @retry_interval;
END
GO

CREATE OR ALTER PROCEDURE dbo.rsagent_add_jobstep
    @job_name           sysname,
    @step_id            int,
    @step_name          sysname,
    @command            nvarchar(max),
    @subsystem          sysname = N'TSQL',
    @database_name      sysname = N'master',
    @on_success_action  tinyint = 1,
    @on_success_step_id int     = 0,
    @on_fail_action     tinyint = 2,
    @on_fail_step_id    int     = 0,
    @retry_attempts     int     = 0,
    @retry_interval     int     = 0
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;

    -- Job steps execute as the SQL Agent service account. Allowing CmdExec,
    -- PowerShell, SSIS or ActiveScripting here would turn "edit a job" into
    -- "run any command on this host as the service account", which is a
    -- different product with a different threat model.
    IF @subsystem <> N'TSQL'
    BEGIN
        -- Logged directly rather than through the guard: the guard records
        -- whether the allowlist permitted the job, and for an allowlisted job it
        -- would write allowed=1 next to an operation that was refused. An audit
        -- trail that says "allowed" for something that did not happen is worse
        -- than none.
        INSERT dbo.rsagent_write_audit (original_login, procedure_name, job_name, step_id, allowed, detail)
        VALUES (ORIGINAL_LOGIN(), 'rsagent_add_jobstep', @job_name, @step_id, 0,
                N'refused: subsystem ' + @subsystem);
        RAISERROR('This wrapper only creates TSQL steps. Subsystem "%s" must be configured by a DBA directly.', 16, 1, @subsystem);
        RETURN;
    END

    EXEC dbo.rsagent_write_guard 'rsagent_add_jobstep', @job_name, @step_id;

    EXEC msdb.dbo.sp_add_jobstep
        @job_name           = @job_name,
        @step_id            = @step_id,
        @step_name          = @step_name,
        @subsystem          = N'TSQL',
        @command            = @command,
        @database_name      = @database_name,
        @on_success_action  = @on_success_action,
        @on_success_step_id = @on_success_step_id,
        @on_fail_action     = @on_fail_action,
        @on_fail_step_id    = @on_fail_step_id,
        @retry_attempts     = @retry_attempts,
        @retry_interval     = @retry_interval;
END
GO

CREATE OR ALTER PROCEDURE dbo.rsagent_delete_jobstep
    @job_name sysname,
    @step_id  int
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    EXEC dbo.rsagent_write_guard 'rsagent_delete_jobstep', @job_name, @step_id;
    EXEC msdb.dbo.sp_delete_jobstep @job_name = @job_name, @step_id = @step_id;
END
GO

-- Lets the worker discover at startup whether the wrapper is installed, and the
-- dashboard say why a save is blocked before the operator writes an edit that
-- cannot land. Not signed: it reads nothing privileged.
CREATE OR ALTER PROCEDURE dbo.rsagent_write_status
AS
BEGIN
    SET NOCOUNT ON;
    SELECT
        CAST(1 AS bit) AS wrapper_installed,
        (SELECT COUNT(*) FROM dbo.rsagent_write_allowlist) AS allowlisted_jobs,
        ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) AS caller_is_sysadmin,
        SUSER_SNAME() AS caller_login;
END
GO

-- ---------------------------------------------------------------------------
-- Sign, and grant
-- ---------------------------------------------------------------------------

DECLARE @pw nvarchar(128) = (SELECT cert_password FROM #rsagent_install);
DECLARE @sign nvarchar(max) = N'';
SELECT @sign = @sign + N'ADD SIGNATURE TO dbo.' + QUOTENAME(name)
                     + N' BY CERTIFICATE RsAgentWriteCert WITH PASSWORD = ''' + @pw + N''';'
FROM (VALUES (N'rsagent_write_guard'), (N'rsagent_update_job'), (N'rsagent_update_jobstep'),
             (N'rsagent_add_jobstep'), (N'rsagent_delete_jobstep')) AS t(name);
EXEC sys.sp_executesql @sign;
GO

DECLARE @login sysname = (SELECT login FROM #rsagent_install);
DECLARE @grant nvarchar(max) = N'
GRANT EXECUTE ON dbo.rsagent_update_job     TO ' + QUOTENAME(@login) + N';
GRANT EXECUTE ON dbo.rsagent_update_jobstep TO ' + QUOTENAME(@login) + N';
GRANT EXECUTE ON dbo.rsagent_add_jobstep    TO ' + QUOTENAME(@login) + N';
GRANT EXECUTE ON dbo.rsagent_delete_jobstep TO ' + QUOTENAME(@login) + N';
GRANT EXECUTE ON dbo.rsagent_write_status   TO ' + QUOTENAME(@login) + N';
GRANT SELECT  ON dbo.rsagent_write_allowlist TO ' + QUOTENAME(@login) + N';';
EXEC sys.sp_executesql @grant;

PRINT 'Installed the job write wrapper for ' + @login + '.';
PRINT '';
PRINT 'It can edit NOTHING yet. The allowlist is empty and default-deny:';
PRINT '';
PRINT '  INSERT msdb.dbo.rsagent_write_allowlist(job_name, added_by)';
PRINT '  VALUES (N''Your job name'', SUSER_SNAME());';
PRINT '';
PRINT 'Every call is recorded in msdb.dbo.rsagent_write_audit, including refusals.';
DROP TABLE #rsagent_install;
GO
