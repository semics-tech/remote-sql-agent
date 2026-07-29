/*
 * Fixture SQL Server Agent jobs for development and integration testing.
 *
 * Deliberately varied: multi-step jobs with branching flow control, every
 * subsystem we claim to support, every freq_type, notification config,
 * disabled jobs, jobs with retries and output files, and a job that fails on
 * purpose (so history has a real failure to render).
 *
 * Idempotent: safe to run repeatedly.
 */

USE [msdb];
GO

SET NOCOUNT ON;
GO

-------------------------------------------------------------------------------
-- Clean slate for the fixture set only (never touches jobs we did not create).
-------------------------------------------------------------------------------
DECLARE @jobName sysname;
DECLARE fixture_jobs CURSOR LOCAL FAST_FORWARD FOR
    SELECT name FROM msdb.dbo.sysjobs WHERE name LIKE N'RSAgent Fixture%';
OPEN fixture_jobs;
FETCH NEXT FROM fixture_jobs INTO @jobName;
WHILE @@FETCH_STATUS = 0
BEGIN
    EXEC msdb.dbo.sp_delete_job @job_name = @jobName, @delete_unused_schedule = 1;
    FETCH NEXT FROM fixture_jobs INTO @jobName;
END
CLOSE fixture_jobs;
DEALLOCATE fixture_jobs;
GO

-------------------------------------------------------------------------------
-- Supporting objects: a target database, a category, and operators.
-------------------------------------------------------------------------------
IF DB_ID(N'RSAgentDemo') IS NULL
    EXEC (N'CREATE DATABASE [RSAgentDemo]');
GO

IF NOT EXISTS (SELECT 1 FROM msdb.dbo.syscategories WHERE name = N'RSAgent Fixtures' AND category_class = 1)
    EXEC msdb.dbo.sp_add_category @class = N'JOB', @type = N'LOCAL', @name = N'RSAgent Fixtures';
GO

IF NOT EXISTS (SELECT 1 FROM msdb.dbo.sysoperators WHERE name = N'DBA Team')
    EXEC msdb.dbo.sp_add_operator
        @name = N'DBA Team',
        @enabled = 1,
        @email_address = N'dba-team@example.invalid',
        @pager_days = 0;
GO

IF NOT EXISTS (SELECT 1 FROM msdb.dbo.sysoperators WHERE name = N'On Call')
    EXEC msdb.dbo.sp_add_operator
        @name = N'On Call',
        @enabled = 1,
        @email_address = N'on-call@example.invalid',
        @pager_address = N'oncall-pager@example.invalid',
        @weekday_pager_start_time = 80000,
        @weekday_pager_end_time = 180000,
        @pager_days = 62;  -- Mon-Fri
GO

-- Demo objects the fixture job steps actually call, so runs do real work.
USE [RSAgentDemo];
GO
IF OBJECT_ID(N'dbo.MaintenanceLog') IS NULL
    CREATE TABLE dbo.MaintenanceLog (
        LogId     INT IDENTITY(1,1) PRIMARY KEY,
        LoggedAt  DATETIME2 NOT NULL CONSTRAINT DF_MaintenanceLog_LoggedAt DEFAULT SYSUTCDATETIME(),
        Source    NVARCHAR(128) NOT NULL,
        Message   NVARCHAR(2000) NULL
    );
GO
CREATE OR ALTER PROCEDURE dbo.usp_LogMaintenance
    @Source NVARCHAR(128),
    @Message NVARCHAR(2000) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    INSERT dbo.MaintenanceLog (Source, Message) VALUES (@Source, @Message);
    PRINT CONCAT(N'Logged: ', @Source, N' - ', ISNULL(@Message, N'(no message)'));
END
GO
CREATE OR ALTER PROCEDURE dbo.usp_RebuildIndexes
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @count INT = (SELECT COUNT(*) FROM sys.indexes WHERE object_id > 100);
    EXEC dbo.usp_LogMaintenance @Source = N'usp_RebuildIndexes',
                                @Message = N'Considered indexes for rebuild';
    PRINT CONCAT(N'Examined ', @count, N' indexes.');
END
GO
USE [msdb];
GO

-------------------------------------------------------------------------------
-- Shared schedules, covering every freq_type we decode.
-------------------------------------------------------------------------------
DECLARE @scheduleNames TABLE (name sysname);
INSERT @scheduleNames VALUES
    (N'RSAgent Fixture - Daily 02:00'),
    (N'RSAgent Fixture - Every 15 min'),
    (N'RSAgent Fixture - Weekly Mon Wed Fri'),
    (N'RSAgent Fixture - Monthly day 15'),
    (N'RSAgent Fixture - Last weekday of quarter'),
    (N'RSAgent Fixture - On agent start'),
    (N'RSAgent Fixture - When CPU idle'),
    (N'RSAgent Fixture - One time only');

DECLARE @sname sysname;
DECLARE sched_cur CURSOR LOCAL FAST_FORWARD FOR SELECT name FROM @scheduleNames;
OPEN sched_cur;
FETCH NEXT FROM sched_cur INTO @sname;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF EXISTS (SELECT 1 FROM msdb.dbo.sysschedules WHERE name = @sname)
        EXEC msdb.dbo.sp_delete_schedule @schedule_name = @sname, @force_delete = 1;
    FETCH NEXT FROM sched_cur INTO @sname;
END
CLOSE sched_cur;
DEALLOCATE sched_cur;
GO

-- freq_type 4 (Daily), once at 02:00
EXEC msdb.dbo.sp_add_schedule
    @schedule_name = N'RSAgent Fixture - Daily 02:00',
    @freq_type = 4, @freq_interval = 1,
    @freq_subday_type = 1, @freq_subday_interval = 0,
    @active_start_date = 20240101, @active_start_time = 20000;

-- freq_type 4 (Daily), every 15 minutes between 06:00 and 22:00
EXEC msdb.dbo.sp_add_schedule
    @schedule_name = N'RSAgent Fixture - Every 15 min',
    @freq_type = 4, @freq_interval = 1,
    @freq_subday_type = 4, @freq_subday_interval = 15,
    @active_start_date = 20240101, @active_start_time = 60000, @active_end_time = 220000;

-- freq_type 8 (Weekly), Mon|Wed|Fri = 2|8|32 = 42, every 2 weeks
EXEC msdb.dbo.sp_add_schedule
    @schedule_name = N'RSAgent Fixture - Weekly Mon Wed Fri',
    @freq_type = 8, @freq_interval = 42, @freq_recurrence_factor = 2,
    @freq_subday_type = 1,
    @active_start_date = 20240101, @active_start_time = 233000;

-- freq_type 16 (Monthly), day 15 of every month
EXEC msdb.dbo.sp_add_schedule
    @schedule_name = N'RSAgent Fixture - Monthly day 15',
    @freq_type = 16, @freq_interval = 15, @freq_recurrence_factor = 1,
    @freq_subday_type = 1,
    @active_start_date = 20240101, @active_start_time = 10000;

-- freq_type 32 (MonthlyRelative), last (16) weekday (9), every 3 months
EXEC msdb.dbo.sp_add_schedule
    @schedule_name = N'RSAgent Fixture - Last weekday of quarter',
    @freq_type = 32, @freq_interval = 9, @freq_relative_interval = 16,
    @freq_recurrence_factor = 3, @freq_subday_type = 1,
    @active_start_date = 20240101, @active_start_time = 40000;

-- freq_type 64 (when Agent starts)
EXEC msdb.dbo.sp_add_schedule
    @schedule_name = N'RSAgent Fixture - On agent start',
    @freq_type = 64, @active_start_date = 20240101;

-- freq_type 128 (when CPU idle)
EXEC msdb.dbo.sp_add_schedule
    @schedule_name = N'RSAgent Fixture - When CPU idle',
    @freq_type = 128, @active_start_date = 20240101;

-- freq_type 1 (once)
EXEC msdb.dbo.sp_add_schedule
    @schedule_name = N'RSAgent Fixture - One time only',
    @freq_type = 1, @active_start_date = 20260101, @active_start_time = 120000;
GO

-------------------------------------------------------------------------------
-- Job 1: multi-step T-SQL maintenance with branching and notifications.
-------------------------------------------------------------------------------
EXEC msdb.dbo.sp_add_job
    @job_name = N'RSAgent Fixture - Nightly Maintenance',
    @description = N'Multi-step nightly maintenance. Exercises step branching and operator notification.',
    @category_name = N'RSAgent Fixtures',
    @enabled = 1,
    @notify_level_email = 2,      -- on failure
    @notify_email_operator_name = N'DBA Team',
    @notify_level_eventlog = 2,
    @owner_login_name = N'sa';

EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'RSAgent Fixture - Nightly Maintenance',
    @step_name = N'Check database integrity',
    @subsystem = N'TSQL', @database_name = N'RSAgentDemo',
    @command = N'DBCC CHECKDB (N''RSAgentDemo'') WITH NO_INFOMSGS, PHYSICAL_ONLY;',
    @on_success_action = 3,       -- go to next step
    @on_fail_action = 4, @on_fail_step_id = 4,   -- jump to the failure handler
    @retry_attempts = 1, @retry_interval = 1;

EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'RSAgent Fixture - Nightly Maintenance',
    @step_name = N'Rebuild indexes',
    @subsystem = N'TSQL', @database_name = N'RSAgentDemo',
    @command = N'EXEC dbo.usp_RebuildIndexes;',
    @on_success_action = 3, @on_fail_action = 4, @on_fail_step_id = 4;

EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'RSAgent Fixture - Nightly Maintenance',
    @step_name = N'Update statistics',
    @subsystem = N'TSQL', @database_name = N'RSAgentDemo',
    @command = N'EXEC dbo.usp_LogMaintenance @Source = N''Update statistics'', @Message = N''Statistics refreshed'';',
    @on_success_action = 1,       -- quit with success
    @on_fail_action = 4, @on_fail_step_id = 4;

EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'RSAgent Fixture - Nightly Maintenance',
    @step_name = N'Record failure',
    @subsystem = N'TSQL', @database_name = N'RSAgentDemo',
    @command = N'EXEC dbo.usp_LogMaintenance @Source = N''Nightly Maintenance'', @Message = N''A maintenance step failed'';',
    @on_success_action = 2,       -- quit with failure: the job did fail
    @on_fail_action = 2;

EXEC msdb.dbo.sp_attach_schedule
    @job_name = N'RSAgent Fixture - Nightly Maintenance',
    @schedule_name = N'RSAgent Fixture - Daily 02:00';

EXEC msdb.dbo.sp_add_jobserver @job_name = N'RSAgent Fixture - Nightly Maintenance';
GO

-------------------------------------------------------------------------------
-- Job 2: frequent, short, succeeds. Generates plenty of history rows.
-------------------------------------------------------------------------------
EXEC msdb.dbo.sp_add_job
    @job_name = N'RSAgent Fixture - Heartbeat Log',
    @description = N'Writes a heartbeat row. Runs often so history and activity views have data.',
    @category_name = N'RSAgent Fixtures',
    @enabled = 1, @owner_login_name = N'sa';

EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'RSAgent Fixture - Heartbeat Log',
    @step_name = N'Write heartbeat',
    @subsystem = N'TSQL', @database_name = N'RSAgentDemo',
    @command = N'EXEC dbo.usp_LogMaintenance @Source = N''Heartbeat'', @Message = N''Still alive'';',
    @on_success_action = 1, @on_fail_action = 2;

EXEC msdb.dbo.sp_attach_schedule
    @job_name = N'RSAgent Fixture - Heartbeat Log',
    @schedule_name = N'RSAgent Fixture - Every 15 min';

EXEC msdb.dbo.sp_add_jobserver @job_name = N'RSAgent Fixture - Heartbeat Log';
GO

-------------------------------------------------------------------------------
-- Job 3: fails on purpose, so the dashboard has a real failure to render.
-------------------------------------------------------------------------------
EXEC msdb.dbo.sp_add_job
    @job_name = N'RSAgent Fixture - Known Failure',
    @description = N'Fails deliberately. Used to verify failure rendering and severity capture.',
    @category_name = N'RSAgent Fixtures',
    @enabled = 1, @owner_login_name = N'sa',
    @notify_level_email = 2, @notify_email_operator_name = N'On Call';

EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'RSAgent Fixture - Known Failure',
    @step_name = N'Raise an error',
    @subsystem = N'TSQL', @database_name = N'RSAgentDemo',
    @command = N'RAISERROR (N''Deliberate fixture failure for testing.'', 16, 1);',
    @on_success_action = 1, @on_fail_action = 2,
    @retry_attempts = 2, @retry_interval = 1;

EXEC msdb.dbo.sp_add_jobserver @job_name = N'RSAgent Fixture - Known Failure';
GO

-------------------------------------------------------------------------------
-- Job 4: CmdExec subsystem with an output file.
-------------------------------------------------------------------------------
EXEC msdb.dbo.sp_add_job
    @job_name = N'RSAgent Fixture - Export Report',
    @description = N'CmdExec step writing to an output file. Exercises non-TSQL subsystems.',
    @category_name = N'RSAgent Fixtures',
    @enabled = 1, @owner_login_name = N'sa';

EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'RSAgent Fixture - Export Report',
    @step_name = N'Write report',
    @subsystem = N'CmdExec',
    @command = N'/bin/echo "RSAgent fixture report"',
    @output_file_name = N'/var/opt/mssql/log/rsagent-fixture-report.txt',
    @flags = 2,                   -- overwrite output file
    @on_success_action = 1, @on_fail_action = 2;

EXEC msdb.dbo.sp_attach_schedule
    @job_name = N'RSAgent Fixture - Export Report',
    @schedule_name = N'RSAgent Fixture - Weekly Mon Wed Fri';

EXEC msdb.dbo.sp_add_jobserver @job_name = N'RSAgent Fixture - Export Report';
GO

-------------------------------------------------------------------------------
-- Job 5: PowerShell subsystem.
-------------------------------------------------------------------------------
EXEC msdb.dbo.sp_add_job
    @job_name = N'RSAgent Fixture - PowerShell Inventory',
    @description = N'PowerShell step. Present so the estate has a job whose body is not T-SQL.',
    @category_name = N'RSAgent Fixtures',
    @enabled = 1, @owner_login_name = N'sa';

EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'RSAgent Fixture - PowerShell Inventory',
    @step_name = N'Collect inventory',
    @subsystem = N'PowerShell',
    @command = N'Write-Output "Collecting inventory"
Get-Date | Write-Output',
    @on_success_action = 1, @on_fail_action = 2;

EXEC msdb.dbo.sp_add_jobserver @job_name = N'RSAgent Fixture - PowerShell Inventory';
GO

-------------------------------------------------------------------------------
-- Job 6: disabled job, monthly schedule.
-------------------------------------------------------------------------------
EXEC msdb.dbo.sp_add_job
    @job_name = N'RSAgent Fixture - Monthly Archive',
    @description = N'Disabled on purpose. Verifies enabled/disabled rendering and toggling.',
    @category_name = N'RSAgent Fixtures',
    @enabled = 0, @owner_login_name = N'sa';

EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'RSAgent Fixture - Monthly Archive',
    @step_name = N'Archive old rows',
    @subsystem = N'TSQL', @database_name = N'RSAgentDemo',
    @command = N'DELETE FROM dbo.MaintenanceLog WHERE LoggedAt < DATEADD(MONTH, -6, SYSUTCDATETIME());',
    @on_success_action = 1, @on_fail_action = 2;

EXEC msdb.dbo.sp_attach_schedule
    @job_name = N'RSAgent Fixture - Monthly Archive',
    @schedule_name = N'RSAgent Fixture - Monthly day 15';

EXEC msdb.dbo.sp_add_jobserver @job_name = N'RSAgent Fixture - Monthly Archive';
GO

-------------------------------------------------------------------------------
-- Job 7: quarterly, monthly-relative schedule.
-------------------------------------------------------------------------------
EXEC msdb.dbo.sp_add_job
    @job_name = N'RSAgent Fixture - Quarterly Reconciliation',
    @description = N'Exercises the monthly-relative (freq_type 32) schedule encoding.',
    @category_name = N'RSAgent Fixtures',
    @enabled = 1, @owner_login_name = N'sa';

EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'RSAgent Fixture - Quarterly Reconciliation',
    @step_name = N'Reconcile',
    @subsystem = N'TSQL', @database_name = N'RSAgentDemo',
    @command = N'EXEC dbo.usp_LogMaintenance @Source = N''Quarterly Reconciliation'', @Message = N''Reconciled'';',
    @on_success_action = 1, @on_fail_action = 2;

EXEC msdb.dbo.sp_attach_schedule
    @job_name = N'RSAgent Fixture - Quarterly Reconciliation',
    @schedule_name = N'RSAgent Fixture - Last weekday of quarter';

EXEC msdb.dbo.sp_add_jobserver @job_name = N'RSAgent Fixture - Quarterly Reconciliation';
GO

-------------------------------------------------------------------------------
-- Job 8: runs when the Agent starts.
-------------------------------------------------------------------------------
EXEC msdb.dbo.sp_add_job
    @job_name = N'RSAgent Fixture - Startup Warmup',
    @description = N'Runs when SQL Server Agent starts (freq_type 64).',
    @category_name = N'RSAgent Fixtures',
    @enabled = 1, @owner_login_name = N'sa';

EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'RSAgent Fixture - Startup Warmup',
    @step_name = N'Warm the cache',
    @subsystem = N'TSQL', @database_name = N'RSAgentDemo',
    @command = N'SELECT COUNT(*) FROM dbo.MaintenanceLog;',
    @on_success_action = 1, @on_fail_action = 2;

EXEC msdb.dbo.sp_attach_schedule
    @job_name = N'RSAgent Fixture - Startup Warmup',
    @schedule_name = N'RSAgent Fixture - On agent start';

EXEC msdb.dbo.sp_add_jobserver @job_name = N'RSAgent Fixture - Startup Warmup';
GO

-------------------------------------------------------------------------------
-- Job 9: idle-time job with a multi-line body (line-ending normalisation).
-------------------------------------------------------------------------------
EXEC msdb.dbo.sp_add_job
    @job_name = N'RSAgent Fixture - Idle Cleanup',
    @description = N'Runs when the CPU is idle. Body is multi-line to exercise text normalisation.',
    @category_name = N'RSAgent Fixtures',
    @enabled = 1, @owner_login_name = N'sa';

EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'RSAgent Fixture - Idle Cleanup',
    @step_name = N'Cleanup',
    @subsystem = N'TSQL', @database_name = N'RSAgentDemo',
    @command = N'SET NOCOUNT ON;

DECLARE @cutoff DATETIME2 = DATEADD(DAY, -30, SYSUTCDATETIME());

DELETE FROM dbo.MaintenanceLog
WHERE  LoggedAt < @cutoff
  AND  Source = N''Heartbeat'';

EXEC dbo.usp_LogMaintenance @Source = N''Idle Cleanup'', @Message = N''Old heartbeats purged'';',
    @on_success_action = 1, @on_fail_action = 2;

EXEC msdb.dbo.sp_attach_schedule
    @job_name = N'RSAgent Fixture - Idle Cleanup',
    @schedule_name = N'RSAgent Fixture - When CPU idle';

EXEC msdb.dbo.sp_add_jobserver @job_name = N'RSAgent Fixture - Idle Cleanup';
GO

-------------------------------------------------------------------------------
-- Job 10: one-time schedule, references a linked server by name.
-- Deliberately mentions "LEGACYFIN01" so cross-estate step-body search (§9.5)
-- has something meaningful to find.
-------------------------------------------------------------------------------
EXEC msdb.dbo.sp_add_job
    @job_name = N'RSAgent Fixture - Legacy Feed Import',
    @description = N'One-time migration job that still references the LEGACYFIN01 server.',
    @category_name = N'RSAgent Fixtures',
    @enabled = 1, @owner_login_name = N'sa';

EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'RSAgent Fixture - Legacy Feed Import',
    @step_name = N'Pull from legacy',
    @subsystem = N'TSQL', @database_name = N'RSAgentDemo',
    @command = N'-- Pulls the nightly feed from the soon-to-be-decommissioned box.
SELECT TOP (0) * FROM OPENQUERY(LEGACYFIN01, ''SELECT 1 AS Placeholder'');',
    @on_success_action = 3, @on_fail_action = 2;

EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'RSAgent Fixture - Legacy Feed Import',
    @step_name = N'Log completion',
    @subsystem = N'TSQL', @database_name = N'RSAgentDemo',
    @command = N'EXEC dbo.usp_LogMaintenance @Source = N''Legacy Feed Import'', @Message = N''Feed imported from LEGACYFIN01'';',
    @on_success_action = 1, @on_fail_action = 2;

EXEC msdb.dbo.sp_attach_schedule
    @job_name = N'RSAgent Fixture - Legacy Feed Import',
    @schedule_name = N'RSAgent Fixture - One time only';

EXEC msdb.dbo.sp_add_jobserver @job_name = N'RSAgent Fixture - Legacy Feed Import';
GO

-------------------------------------------------------------------------------
-- Give the estate some history immediately: run the two fast, safe jobs.
-------------------------------------------------------------------------------
EXEC msdb.dbo.sp_start_job @job_name = N'RSAgent Fixture - Heartbeat Log';
EXEC msdb.dbo.sp_start_job @job_name = N'RSAgent Fixture - Known Failure';
GO

SELECT CONCAT(N'Seeded ', COUNT(*), N' fixture jobs.')
FROM   msdb.dbo.sysjobs
WHERE  name LIKE N'RSAgent Fixture%';
GO
