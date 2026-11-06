/**
 * Datenbank-Typen für supabase-js (Plan 009). Aus `generate_typescript_types` (Supabase MCP) übernommen und auf
 * das gekürzt, was der Client liest; avatar_url der RPC-Zeilen als nullable korrigiert (der Generator kennt die
 * Nullbarkeit von SQL-Funktionsergebnissen nicht). Schema: supabase/migrations/*.sql.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface BoardRow {
  readonly rank: number;
  readonly user_id: string;
  readonly display_name: string;
  readonly avatar_url: string | null;
  /** 'player' | 'dev' (Migration online_profiles_role). */
  readonly role: string;
  readonly time_ms: number;
  readonly run_id: string;
  readonly achieved_at: string;
  readonly total: number;
}

/** RPC get_player_profile (jsonb; Migration online_player_profile). null = unbekannt oder gebannt. */
export interface ProfileRpcBest {
  readonly level_id: string;
  readonly level_hash: string;
  readonly physics_version: number;
  readonly time_ms: number;
  readonly run_id: string;
  readonly achieved_at: string;
  readonly rank: number;
  readonly total: number;
}

export interface ProfileRpc {
  readonly id: string;
  readonly display_name: string;
  readonly avatar_url: string | null;
  readonly role: string;
  readonly created_at: string;
  readonly runs: number;
  readonly world_records: number;
  readonly bests: readonly ProfileRpcBest[];
}

/** Zeile von admin_list_runs (Migration online_admin). */
export interface AdminRunRow {
  readonly run_id: string;
  readonly user_id: string;
  readonly display_name: string;
  readonly role: string;
  readonly is_banned: boolean;
  readonly level_id: string;
  readonly level_hash: string;
  readonly physics_version: number;
  readonly time_ms: number;
  readonly ticks: number;
  readonly created_at: string;
  readonly replay_path: string | null;
  readonly replay_bytes: number | null;
  readonly is_best: boolean;
  readonly total: number;
}

/** Zeile von admin_list_players / admin_set_ban / admin_rename_player. */
export interface AdminPlayerRow {
  readonly user_id: string;
  readonly display_name: string;
  readonly discord_name: string | null;
  readonly avatar_url: string | null;
  readonly role: string;
  readonly is_banned: boolean;
  readonly ban_reason: string | null;
  readonly banned_at: string | null;
  readonly created_at: string;
  readonly runs: number;
  readonly total: number;
}

/** Zeile von admin_audit_log. */
export interface AdminAuditRow {
  readonly id: number;
  readonly at: string;
  readonly actor_id: string;
  readonly actor_name: string | null;
  readonly action: string;
  readonly target_user: string | null;
  readonly target_name: string | null;
  readonly target_run: string | null;
  readonly detail: Json;
  readonly total: number;
}

export type Database = {
  __InternalSupabase: { PostgrestVersion: '14.18' };
  public: {
    Tables: {
      best_runs: {
        Row: {
          achieved_at: string;
          hidden: boolean;
          level_hash: string;
          level_id: string;
          physics_version: number;
          run_id: string;
          time_ms: number;
          user_id: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      profiles: {
        /** Öffentlich lesbar sind nur id, display_name, avatar_url, role, created_at (Spalten-Grants). */
        Row: {
          avatar_url: string | null;
          created_at: string;
          display_name: string;
          id: string;
          role: string;
        };
        Insert: never;
        /** Clients dürfen nur display_name ändern. */
        Update: { display_name?: string };
        Relationships: [];
      };
      runs: {
        Row: {
          created_at: string;
          id: string;
          level_hash: string;
          level_id: string;
          physics_version: number;
          replay_bytes: number | null;
          replay_path: string | null;
          settings: Json;
          splits: number[];
          ticks: number;
          time_ms: number;
          user_id: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      get_leaderboard: {
        Args: { p_level: string; p_level_hash: string; p_physics: number; p_limit?: number; p_offset?: number };
        Returns: BoardRow[];
      };
      get_rank_around: {
        Args: { p_level: string; p_level_hash: string; p_physics: number; p_user: string; p_radius?: number };
        Returns: BoardRow[];
      };
      get_player_profile: {
        Args: { p_user: string; p_boards: Json };
        Returns: Json;
      };
      admin_list_runs: {
        Args: { p_level?: string; p_user?: string; p_limit?: number; p_offset?: number };
        Returns: AdminRunRow[];
      };
      admin_list_players: {
        Args: { p_search?: string; p_banned_only?: boolean; p_limit?: number; p_offset?: number };
        Returns: AdminPlayerRow[];
      };
      admin_set_ban: {
        Args: { p_user: string; p_banned: boolean; p_reason?: string };
        Returns: AdminPlayerRow[];
      };
      admin_rename_player: {
        Args: { p_user: string; p_name: string; p_reason?: string };
        Returns: AdminPlayerRow[];
      };
      admin_audit_log: {
        Args: { p_limit?: number; p_offset?: number; p_user?: string };
        Returns: AdminAuditRow[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
