export type Rank =
  | 'BEST_VALUE'
  | 'STRONG_VALUE'
  | 'MODERATE_VALUE'
  | 'NO_VALUE'
  | 'AVOID'
  | 'INSUFFICIENT_DATA';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY HIGH';

export interface User {
  id: number;
  email: string;
  role: 'user' | 'admin';
}

export interface Evaluation {
  key: string;
  market: string;
  market_label: string;
  category: string;
  tab: string;
  stat: 'goals' | 'corners' | 'cards';
  label: string;
  side: string;
  team: string | null;
  line: number | null;
  status: 'OK' | 'INSUFFICIENT_DATA';
  probability: number | null;
  push_probability: number | null;
  fair_odds: number | null;
  odds: number | null;
  bookmaker: string | null;
  bookmakers: number;
  implied_probability: number | null;
  no_vig_probability: number | null;
  edge_pp: number | null;
  value_pct: number | null;
  confidence: number | null;
  confidence_components: Record<string, number>;
  risk: RiskLevel | null;
  risk_factors: string[];
  rank: Rank;
  rank_note: string | null;
  opening_odds: number | null;
  movement_pct: number | null;
  model_spread: number | null;
}

export interface FixtureMeta {
  fixture_id: number;
  kickoff: string;
  status: string;
  elapsed: number | null;
  league_id: number | null;
  league: string | null;
  country: string | null;
  home: string;
  away: string;
  home_logo: string | null;
  away_logo: string | null;
  home_goals: number | null;
  away_goals: number | null;
}

export type ScanResult = Evaluation & FixtureMeta & { match: string };

export interface DataStatus {
  football_api_configured: boolean;
  odds_api_configured: boolean;
  enabled_leagues: number;
  last_analysis_at: string | null;
  last_odds_at: string | null;
}

export interface Dashboard {
  matches_today: number;
  analysed: number;
  value_opportunities: number;
  strong_signals: number;
  high_risk: number;
  best_value: ScanResult[];
  data_status: DataStatus;
}

export interface MatchCard extends FixtureMeta {
  analysed: boolean;
  computed_at?: string;
  value_count: number;
  strong_count: number;
  high_risk_count?: number;
  has_odds?: boolean;
  insufficient: string[] | null;
  best: Partial<Evaluation> | null;
}

export interface ModelLambda {
  name: string;
  lambda_home: number;
  lambda_away: number;
  matches_home: number;
  matches_away: number;
}

export interface StatModel {
  stat: string;
  status: 'OK' | 'INSUFFICIENT_DATA';
  reason: string | null;
  lambda_home: number | null;
  lambda_away: number | null;
  models: ModelLambda[];
  adjustments: string[];
  data_quality: number;
  min_matches: number;
  relative_stderr: number;
  form_drift: number | null;
  dispersion_home: number | null;
  dispersion_away: number | null;
}

export interface FormBlock {
  matches: number;
  sequence?: string;
  wins?: number;
  draws?: number;
  losses?: number;
  goals_for?: number;
  goals_against?: number;
  goals_for_per_game?: number;
  goals_against_per_game?: number;
  clean_sheets?: number;
  btts_rate?: number | null;
  over_1_5_rate?: number | null;
  over_2_5_rate?: number | null;
  under_2_5_rate?: number | null;
  points_per_game?: number;
  ht_results?: string | null;
  results?: {
    fixture_id: number;
    date: string;
    home: boolean;
    score: string;
    ht: string | null;
    result: 'W' | 'D' | 'L';
  }[];
}

export type NumMap = Record<string, number | null>;

export interface TeamSummary {
  form: { last5: FormBlock; last10: FormBlock; last15: FormBlock; venue: FormBlock };
  attack: NumMap;
  defence: NumMap;
  corners: NumMap;
  cards: NumMap;
}

export interface Squad {
  lineup_confirmed: boolean | null;
  injuries_known: boolean;
  missing_players: string[];
  missing_goal_share: number | null;
  missing_key_defenders: number;
  returning_players: string[];
  injuries: { player: string; type: string | null; reason: string | null }[];
  lineup: {
    formation: string | null;
    coach: string | null;
    start_xi: { id: number; name: string; number?: number; pos?: string }[];
    substitutes: { id: number; name: string; number?: number; pos?: string }[];
  } | null;
  contributors: { player: string; contributions: number; missing: boolean }[];
}

export interface Tactics {
  formation: string | null;
  formation_source: string | null;
  possession: number | null;
  shots_per_game: number | null;
  style: string | null;
  pressing: null;
  defensive_line: null;
  counter_attacks: null;
}

export interface ScheduleInfo {
  rest_days: number | null;
  matches_last_7: number;
  matches_last_14: number;
  travel_km: number | null;
}

export interface Referee {
  name: string;
  matches: number;
  avg_cards: number;
  avg_fouls: number | null;
  avg_home_cards: number | null;
  avg_away_cards: number | null;
}

export interface MatchAnalysis {
  fixture_id: number;
  computed_at: string;
  stats: Record<'goals' | 'corners' | 'cards', StatModel>;
  evaluations: Evaluation[];
  top_scores: { home: number; away: number; probability: number }[];
  context: {
    home: TeamSummary;
    away: TeamSummary;
    home_squad: Squad;
    away_squad: Squad;
    home_tactics: Tactics;
    away_tactics: Tactics;
    home_schedule: ScheduleInfo | null;
    away_schedule: ScheduleInfo | null;
    referee: Referee | null;
    referee_distribution: Record<string, number>;
    h2h: {
      fixture_id: number;
      date: string;
      home: string;
      away: string;
      score: string;
      league: string | null;
      age_days: number;
    }[];
    odds_updated_at: string | null;
  };
}

export interface MatchDetail {
  fixture: FixtureMeta & {
    venue: string | null;
    referee: string | null;
    round: string | null;
    ht_home_goals: number | null;
    ht_away_goals: number | null;
  };
  analysis: MatchAnalysis | null;
}

export interface Movement {
  opening: number;
  current: number;
  lowest: number;
  highest: number;
  movement_pct: number;
  direction: 'shortening' | 'drifting' | 'stable';
  alert: string | null;
  opened_at: string;
  updated_at: string;
  samples: number;
}

export interface OddsSelection {
  key: string;
  label: string;
  market: string;
  bookmakers: Record<string, number>;
  movement: Movement | null;
  series?: { time: string; odds: number }[];
}

export interface Meta {
  user: User;
  markets: { key: string; label: string; category: string; tab: string; enabled: boolean }[];
  categories: string[];
  risks: RiskLevel[];
  ranks: Rank[];
  leagues: { id: number; name: string; country: string | null; logo: string | null }[];
  countries: string[];
}

export interface Filters {
  min_probability: number;
  min_value: number;
  max_risk: RiskLevel;
  min_confidence: number;
}

export interface Performance {
  total_bets: number;
  settled_bets: number;
  wins: number;
  losses: number;
  pushes: number;
  win_rate: number | null;
  average_odds: number | null;
  profit: number;
  staked: number;
  roi: number | null;
  max_drawdown: number;
  brier_score: number | null;
  log_loss: number | null;
}

export interface HistoryItem {
  id: number;
  date: string;
  fixture_id: number;
  match: string;
  league: string | null;
  score: string | null;
  market: string;
  category: string;
  label: string;
  odds: number;
  bookmaker: string | null;
  probability: number;
  fair_odds: number;
  value_pct: number;
  confidence: number;
  risk: RiskLevel;
  rank: Rank;
  status: string;
  result: string | null;
  profit: number | null;
}
