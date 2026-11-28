alter table requests add column admitted_inflight integer check (admitted_inflight > 0);
