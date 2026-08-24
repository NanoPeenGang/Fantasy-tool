-- LeagueOps schema. Applied by scripts/migrate.ts, which runs this file in a
-- single transaction; every statement is idempotent so it doubles as the
-- migration for an existing database.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE game_status AS ENUM ('pre', 'live', 'final');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE odds_phase AS ENUM ('open', 'live', 'close');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE storyline_status AS ENUM ('live', 'resolved', 'retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE report_kind AS ENUM ('aar', 'commissioner');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE matchup_status AS ENUM ('pre', 'live', 'final');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS leagues (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sleeper_league_id   text NOT NULL,
  season              text NOT NULL,
  name                text NOT NULL,
  scoring_settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  roster_positions    jsonb NOT NULL DEFAULT '[]'::jsonb,
  previous_league_id  text,
  -- Heat ceiling the commissioner set. Managers may opt down, never up past it.
  heat_ceiling        text NOT NULL DEFAULT 'group_chat',
  voice_preset        text NOT NULL DEFAULT 'drunk_anchor',
  delivery_config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner_user_id       text,
  connected_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sleeper_league_id, season)
);

CREATE TABLE IF NOT EXISTS managers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id       uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  sleeper_user_id text NOT NULL,
  display_name    text NOT NULL,
  team_name       text,
  avatar          text,
  -- Per-manager opt-down from the league heat ceiling. Never an opt-up.
  roast_opt_down  boolean NOT NULL DEFAULT false,
  persona_notes   text,
  UNIQUE (league_id, sleeper_user_id)
);

CREATE TABLE IF NOT EXISTS rosters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id   uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  roster_id   integer NOT NULL,
  manager_id  uuid REFERENCES managers(id) ON DELETE SET NULL,
  players     jsonb NOT NULL DEFAULT '[]'::jsonb,
  starters    jsonb NOT NULL DEFAULT '[]'::jsonb,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league_id, roster_id)
);

CREATE TABLE IF NOT EXISTS players (
  sleeper_id    text PRIMARY KEY,
  name          text NOT NULL,
  position      text NOT NULL,
  team          text,
  injury_status text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS player_week_stats (
  player_id        text NOT NULL,
  season           text NOT NULL,
  week             integer NOT NULL,
  stats            jsonb NOT NULL DEFAULT '{}'::jsonb,
  fantasy_points   numeric NOT NULL DEFAULT 0,
  game_status      game_status NOT NULL DEFAULT 'pre',
  game_pct_elapsed numeric NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, season, week)
);

CREATE TABLE IF NOT EXISTS projections (
  player_id  text NOT NULL,
  season     text NOT NULL,
  week       integer NOT NULL,
  -- 'consensus' | 'props' | 'internal' | vendor name. Blending is a config
  -- change rather than a rewrite because of this column.
  source     text NOT NULL,
  mean       numeric NOT NULL,
  sd         numeric,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, season, week, source)
);

CREATE TABLE IF NOT EXISTS matchups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id  uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  week       integer NOT NULL,
  matchup_id integer NOT NULL,
  roster_a   integer NOT NULL,
  roster_b   integer,
  points_a   numeric NOT NULL DEFAULT 0,
  points_b   numeric NOT NULL DEFAULT 0,
  status     matchup_status NOT NULL DEFAULT 'pre',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league_id, week, matchup_id)
);

CREATE TABLE IF NOT EXISTS odds_snapshots (
  id           bigserial PRIMARY KEY,
  matchup_id   uuid NOT NULL REFERENCES matchups(id) ON DELETE CASCADE,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  win_prob_a   numeric NOT NULL,
  spread       numeric NOT NULL,
  total        numeric NOT NULL,
  moneyline_a  integer NOT NULL,
  moneyline_b  integer NOT NULL,
  phase        odds_phase NOT NULL,
  -- Score state at capture time, so the swing chart can attribute a delta to a
  -- player without re-deriving it from player_week_stats history we do not keep.
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS odds_snapshots_matchup_time
  ON odds_snapshots (matchup_id, captured_at);

CREATE TABLE IF NOT EXISTS stat_packets (
  league_id   uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  week        integer NOT NULL,
  payload     jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, week)
);

CREATE TABLE IF NOT EXISTS storylines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id             uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  season                text NOT NULL,
  thread_key            text NOT NULL,
  summary               text NOT NULL,
  first_week            integer NOT NULL,
  last_referenced_week  integer NOT NULL,
  status                storyline_status NOT NULL DEFAULT 'live',
  manager_ids           jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league_id, season, thread_key)
);

CREATE TABLE IF NOT EXISTS awards (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id  uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  week       integer NOT NULL,
  award_key  text NOT NULL,
  manager_id uuid REFERENCES managers(id) ON DELETE CASCADE,
  value      numeric,
  evidence   jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (league_id, week, award_key)
);

CREATE TABLE IF NOT EXISTS reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  week              integer NOT NULL,
  kind              report_kind NOT NULL,
  -- For AARs this is the matchup id; for commissioner reports, the voice preset.
  variant           text NOT NULL DEFAULT '',
  body              text NOT NULL,
  fact_check_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league_id, week, kind, variant)
);

CREATE TABLE IF NOT EXISTS draft_tendencies (
  league_id   uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  manager_id  uuid NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  metric_key  text NOT NULL,
  value       numeric NOT NULL,
  sample_size integer NOT NULL DEFAULT 0,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, manager_id, metric_key)
);

CREATE INDEX IF NOT EXISTS player_week_stats_week ON player_week_stats (season, week);
CREATE INDEX IF NOT EXISTS projections_week ON projections (season, week, source);
CREATE INDEX IF NOT EXISTS matchups_league_week ON matchups (league_id, week);
CREATE INDEX IF NOT EXISTS storylines_live ON storylines (league_id, season, status);
