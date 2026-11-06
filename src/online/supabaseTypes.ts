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
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
