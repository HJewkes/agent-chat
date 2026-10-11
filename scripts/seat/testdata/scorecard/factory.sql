create table workflow_run (id text primary key, workflow_name text, params text, status text, step_results text, started_at text, completed_at text);
create table shepherd_registration (run_id text, repo text, pr integer, task text, created_at text);
create table shepherd_freeze (repo text primary key, red_sha text, frozen_at text, episode integer, thawed_at text);
create table hitl_gate (id text primary key, status text, created_at text);
insert into workflow_run values
 ('r1','shepherd-pr','{"repo":"o/proj","pr":"1","task":"proj/T-1"}','completed','{"merge:0:0":{"completedAt":"2026-10-03T10:00:00.000Z","data":{"result":{"done":true,"mergeSha":"a"}}}}','2026-10-03T09:00:00.000Z','2026-10-03T10:01:00.000Z'),
 ('r2','shepherd-pr','{"repo":"o/proj","pr":"2","task":"proj/T-2"}','completed','{"approve-merge":{"data":{"decision":"merge"}},"merge:0:0":{"completedAt":"2026-10-03T11:00:00.000Z","data":{"result":{"done":true,"mergeSha":"b"}}}}','2026-10-03T09:30:00.000Z','2026-10-03T11:01:00.000Z'),
 ('r3','shepherd-pr','{"repo":"o/proj","pr":"3","task":"proj/T-1"}','completed','{"merge:0:0":{"completedAt":"2026-10-02T10:00:00.000Z","data":{"result":{"done":true,"mergeSha":"c"}}}}','2026-10-02T09:00:00.000Z','2026-10-02T10:01:00.000Z'),
 ('r4','shepherd-pr','{"repo":"o/proj","pr":"4","task":"proj/T-1"}','running','{}','2026-10-03T09:00:00.000Z',null);
insert into shepherd_registration values
 ('r1','o/proj',1,'proj/T-1','2026-10-03T09:30:00.000Z'),
 ('r2','o/proj',2,'proj/T-2','2026-10-03T10:00:00.000Z');
insert into shepherd_freeze values
 ('o/proj','x','2026-10-03T12:00:00.000Z',1,'2026-10-03T12:40:00.000Z'),
 ('o/other','y','2026-10-04T06:00:00.000Z',1,null);
insert into hitl_gate values
 ('r8/approve-merge','pending','2026-10-03T08:00:00.000Z'),
 ('r9/approve-merge','pending','2026-10-04T11:30:00.000Z'),
 ('r7/approve-merge','resolved','2026-10-03T07:00:00.000Z');
