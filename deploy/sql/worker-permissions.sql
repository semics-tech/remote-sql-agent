-- Permissions for the worker's SQL login. Run once per monitored instance, as
-- an administrator, then restart the worker.
--
-- Edit @login below and nothing else.
--
--   sqlcmd -S localhost -E -i worker-permissions.sql
--
-- Why role membership alone is not enough:
--
--   SQLAgentReaderRole and SQLAgentOperatorRole grant EXECUTE on the sp_help_*
--   procedures. They do NOT grant SELECT on the tables underneath. The worker
--   reads those tables directly — it tracks a high-water mark over
--   sysjobhistory.instance_id so it can read history incrementally, and no
--   stored procedure exposes that.
--
--   The symptom is a login that browses jobs perfectly in SSMS, because SSMS
--   goes through sp_help_job, and then fails in the worker with
--   "The SELECT permission was denied on the object 'sysjobhistory'".
--
--   Measured on SQL Server 2022: with SQLAgentOperatorRole alone, ten of the
--   twelve tables below are denied. Only syscategories and sysoperators are
--   readable, because those carry a grant to public.
--
-- This grants read access to every Agent job on the instance, which is the
-- point — an estate view is meaningless if a job is invisible because someone
-- else owns it. It grants nothing outside msdb and nothing that can change
-- anything: writes go through SQLAgentOperatorRole and the stored procedures.

USE [msdb];
GO

DECLARE @login sysname = N'rsagent_worker';   -- <-- change this

-- The grantee must already exist as a user in msdb. Checked rather than
-- assumed: granting to a name that is not there fails per-statement while the
-- script carries on, so without this the run ends with a success message and
-- no permissions.
IF DATABASE_PRINCIPAL_ID(@login) IS NULL
BEGIN
    RAISERROR(
        'No user named "%s" in msdb. Create it first:
  USE [master]; CREATE LOGIN [%s] FROM WINDOWS;   -- or WITH PASSWORD = ...
  USE [msdb];   CREATE USER [%s] FOR LOGIN [%s];
  ALTER ROLE [SQLAgentReaderRole] ADD MEMBER [%s];',
        16, 1, @login, @login, @login, @login, @login);
    RETURN;
END

DECLARE @sql nvarchar(max) = N'';

-- Every msdb object read directly by packages/worker/src/sql/agent-repo.ts.
SELECT @sql = @sql + N'GRANT SELECT ON dbo.' + QUOTENAME(name)
                   + N' TO ' + QUOTENAME(@login) + N';' + CHAR(13)
FROM (VALUES
    (N'sysjobs'),            -- job definitions
    (N'sysjobsteps'),        -- steps, and the flow between them
    (N'sysjobhistory'),      -- run history, read incrementally
    (N'sysjobactivity'),     -- what is running right now
    (N'sysjobschedules'),    -- job-to-schedule links
    (N'sysschedules'),       -- schedule definitions
    (N'sysjobservers'),      -- multi-server job targets
    (N'syscategories'),      -- job categories
    (N'sysoperators'),       -- notification operators
    (N'sysproxies'),         -- proxy accounts a step may run as
    (N'syssessions'),        -- Agent restarts, used to age out activity
    (N'systargetservers')    -- multi-server topology
) AS t(name);

-- Converts Agent's integer date and time columns into real datetimes.
SET @sql = @sql + N'GRANT EXECUTE ON dbo.agent_datetime TO ' + QUOTENAME(@login) + N';';

EXEC sys.sp_executesql @sql;

PRINT 'Granted msdb read access to ' + @login + '.';
PRINT '';
PRINT 'Role membership is still required and is NOT granted here:';
PRINT '  SQLAgentReaderRole    - the minimum, read-only';
PRINT '  SQLAgentOperatorRole  - additionally start/stop/enable/disable and edit';
PRINT 'Never grant sysadmin.';
GO
