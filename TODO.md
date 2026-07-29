# Functionality
1. Add a dashboard page to show an overview of things like jobs that are running, long running, recently failed, worker status'
1. For each active job, show a 'live' graph of the job steps with a visual indication of which step is currently running, and the status of each step (success, failure, etc.)
1. On the dashboard / other page, ability to group jobs together to see their status at a glance (e.g. by job type, by owner, by schedule, etc.) across all or some of the workers by job name, job type, owner, schedule, etc.
1. Ability to change granted permissions per worker
1. Notification page to be setup for jobs, destinations include email, slack, teams etc...

# Queries and bugs
1. Why are we showing 'drifted'? I'm not sure this is important, if it's changed then it's changed and that's fine. only show a badge if there is a conflict, issue or the job is running (maybe?)
1. Do we need approvals for a changed job definition? Maybe for users or non-admins? But when I change one, it says it needs approval, I'm not sure we need this level of control.
1. When a job is started from the portal, it should instantly show that it's running in the dashboard and then poll or websocket will update if and when the job finishes. Currently it needs me to refresh the page to see that it's running, which is not ideal.
1. When you click into a 'job', I don't think there should be a seperate edit page, you should be able to click on the job, it goes by default to the edit page and the user can edit, a bit like how it works in SQL Agent already. Also there's nowhere to add, remove or re-organise job steps
    - On top of this, when you drill into a job it should show the stats of the job in a couple of small high level charts and numbers. Then when you start the job it should show the live graph to simulate that the user is seeing how long it runs for and then which step it goes to next. We could also show the previous and average runtimes on this graph