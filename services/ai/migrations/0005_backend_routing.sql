create table routing_settings (
  singleton boolean primary key default true check (singleton),
  strategy text not null check (strategy in ('leastLoaded', 'roundRobin', 'single')),
  wait_seconds integer not null check (wait_seconds between 0 and 60)
);

create table backend_routing (
  name text primary key,
  priority integer not null check (priority between 0 and 65535),
  max_streams integer check (max_streams between 1 and 65535)
);
