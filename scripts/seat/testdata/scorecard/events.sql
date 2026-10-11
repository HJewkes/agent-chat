create table events (id integer primary key autoincrement, ts integer not null, kind text not null, actor text not null, target text, msg_id text, ref text, body text, meta text);
insert into events (ts, kind, actor, body) values
 (1790000000000,'message','rv','Verdict: FIX_FIRST
PR: o/old#9
Head: 0'),
 (1791050000000,'message','rv','Verdict: FIX_FIRST
PR: o/proj#1
Head: a'),
 (1791051000000,'message','rv','Verdict: MERGE
PR: o/proj#1
Head: a2'),
 (1791052000000,'message','rv','Verdict: MERGE
PR: o/proj#2
Head: b'),
 (1791053000000,'message','rv','Verdict: MERGE
PR: o/proj#7
Head: c'),
 (1791054000000,'message','rv','Verdict: FIX_FIRST
PR: o/proj#8
Head: d'),
 (1791055000000,'message','rv','not a verdict'),
 (1791056000000,'message','rv','Verdict: WAIT
PR: o/proj#3
Head: e'),
 (1791057000000,'message','rv','Verdict: MERGE
PR: o/proj#3
Head: e'),
 (1791058000000,'message','rv','Verdict: WAIT
PR: o/proj#4
Head: f'),
 (1791059000000,'message','rv','Verdict: FIX_FIRST
PR: o/proj#4
Head: f'),
 (1791060000000,'message','rv','Verdict: WAIT
PR: o/proj#5
Head: g');
