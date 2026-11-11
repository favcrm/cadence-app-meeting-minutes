import type { MeetingProfile } from "../../src/features/minutes/types";

export interface SyntheticHistoryRow {
  revision: number;
  operation: "create" | "update";
  actor: string;
  at: number;
  digest: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  provenance: Record<string, unknown> | null;
}

export interface SyntheticMeetingRow {
  id: string;
  revision: number;
  digest: string;
  profile: MeetingProfile;
  history: SyntheticHistoryRow[];
}

export const SYNTHETIC_DIGEST_BASE =
  "sha256:03030303030303030303030303030303030303030303030303030303030303";

export function syntheticDigest(seq: number): string {
  return `${SYNTHETIC_DIGEST_BASE}${String(seq % 100).padStart(2, "0")}`;
}

export function createSeedMeetings(): SyntheticMeetingRow[] {
  const p1: MeetingProfile = {
    schema: 1,
    title: "Q4 enterprise onboarding & billing alignment",
    title_source: "user",
    status: "reviewed",
    held_at: "2026-11-10T02:00:00Z",
    duration_seconds: 2700,
    participants_text: "Carmen Leung, Alex Wong, Priya Nair",
    participants: ["Carmen Leung", "Alex Wong", "Priya Nair"],
    summary:
      "Aligned Q4 enterprise onboarding milestones, confirmed invoice cutoff on the 25th, and scoped bilingual welcome templates for Hong Kong accounts.",
    decisions: [
      {
        id: "dec-1",
        text: "Keep enterprise onboarding checklist in two stages (workspace setup, then billing handoff).",
        quote: "Two stages work cleanly: workspace setup first, billing handoff right after.",
        timestamp: "04:15",
      },
      {
        id: "dec-2",
        text: "Standardize monthly invoice cutoff on the 25th HKT.",
        quote: null,
        timestamp: null,
      },
    ],
    followups: [
      {
        id: "fup-1",
        task: "Share revised bilingual welcome email copy with CS lead",
        owner: "Carmen Leung",
        due: "2026-11-14",
        status: "open",
      },
      {
        id: "fup-2",
        task: "Confirm finance webhook retry window in staging",
        owner: null,
        due: null,
        status: "open",
      },
      {
        id: "fup-3",
        task: "Archive Q3 pilot checklist template",
        owner: "Alex Wong",
        due: "2026-11-11",
        status: "done",
      },
    ],
    transcript: [
      "[00:42] Carmen Leung: Let's lock the enterprise onboarding sequence so CS and finance stop waiting on each other.",
      "[04:15] Alex Wong: Two stages work cleanly: workspace setup first, billing handoff right after.",
      "[11:08] Priya Nair: Agreed. We still need someone to verify the finance webhook retry window — let's leave owner unassigned until afternoon standup.",
    ].join("\n"),
    tags: ["onboarding", "q4", "enterprise"],
    synthetic: true,
  };

  const p2: MeetingProfile = {
    schema: 1,
    title: "Reviewing November Harbour City pop-up staffing and POS readiness",
    title_source: "generated",
    status: "reviewed",
    held_at: "2026-11-08T08:30:00Z",
    duration_seconds: 1800,
    participants_text: "Jason Chan, Mei Lin",
    participants: ["Jason Chan", "Mei Lin"],
    summary:
      "Reviewed weekend pop-up footfall assumptions, backup LTE router placement, and evening shift handover notes.",
    decisions: [
      {
        id: "dec-hk-1",
        text: "Pre-stage two spare receipt printers behind counter B.",
        quote: "Counter B needs two spare receipt rolls and a pre-paired backup printer.",
        timestamp: "06:22",
      },
    ],
    followups: [
      {
        id: "fup-hk-1",
        task: "Test backup LTE failover before Friday 18:00 opening",
        owner: "Jason Chan",
        due: "2026-11-13",
        status: "open",
      },
    ],
    transcript: [
      "[00:10] Jason Chan: Reviewing November Harbour City pop-up staffing and POS readiness before Friday's setup.",
      "[06:22] Mei Lin: Counter B needs two spare receipt rolls and a pre-paired backup printer.",
    ].join("\n"),
    tags: ["retail", "ops"],
    synthetic: true,
  };

  const p3: MeetingProfile = {
    schema: 1,
    title: "週三產品設計檢討：會議紀錄抽屜與雙語詞彙對齊",
    title_source: "generated",
    status: "draft",
    held_at: "2026-11-11T04:30:00Z",
    duration_seconds: 1500,
    participants_text: "陳曉彤, 黃浩然",
    participants: ["陳曉彤", "黃浩然"],
    summary:
      "整理會議紀錄模組的狀態篩選、行動裝置 390px 表格細節，以及書面繁體中文用詞（避免中英夾雜）。",
    decisions: [],
    followups: [
      {
        id: "fup-zh-1",
        task: "核對空白狀態與唯讀提示的書面語翻譯",
        owner: "陳曉彤",
        due: "2026-11-12",
        status: "open",
      },
    ],
    transcript: [
      "[01:05] 陳曉彤: 週三產品設計檢討：會議紀錄抽屜與雙語詞彙對齊，先把草稿記下來。",
      "[08:40] 黃浩然: 標題如果用戶手動設定過，之後更新內容時不可自動降級覆蓋。",
    ].join("\n"),
    tags: ["design", "zh-hk"],
    synthetic: true,
  };

  const p4: MeetingProfile = {
    schema: 1,
    title: "October print vendor wrap-up",
    title_source: "user",
    status: "archived",
    held_at: "2026-10-20T06:00:00Z",
    duration_seconds: 1200,
    participants_text: "Mei Lin, Carmen Leung",
    participants: ["Mei Lin", "Carmen Leung"],
    summary: "Closed October brochure print run and signed off final proof delivery.",
    decisions: [
      {
        id: "dec-oct-1",
        text: "Retain current offset supplier for winter lookbook.",
        quote: null,
        timestamp: "02:00",
      },
    ],
    followups: [
      {
        id: "fup-oct-1",
        task: "Countersign final delivery note",
        owner: "Mei Lin",
        due: "2026-10-24",
        status: "done",
      },
    ],
    transcript: "[02:00] Mei Lin: All 1,500 copies arrived on schedule and passed colour check.",
    tags: ["print", "archived"],
    synthetic: true,
  };

  return [
    {
      id: "mtg-q4-pricing-sync",
      revision: 2,
      digest: syntheticDigest(12),
      profile: p1,
      history: [
        {
          revision: 1,
          operation: "create",
          actor: "user:carmen-preview",
          at: Date.parse("2026-11-10T02:15:00Z"),
          digest: syntheticDigest(11),
          before: null,
          after: p1 as unknown as Record<string, unknown>,
          provenance: { method: "screen_form" },
        },
        {
          revision: 2,
          operation: "update",
          actor: "user:carmen-preview",
          at: Date.parse("2026-11-10T03:05:00Z"),
          digest: syntheticDigest(12),
          before: p1 as unknown as Record<string, unknown>,
          after: p1 as unknown as Record<string, unknown>,
          provenance: { method: "inline_rename" },
        },
      ],
    },
    {
      id: "mtg-hk-retail-retro",
      revision: 1,
      digest: syntheticDigest(21),
      profile: p2,
      history: [
        {
          revision: 1,
          operation: "create",
          actor: "user:jason-preview",
          at: Date.parse("2026-11-08T09:30:00Z"),
          digest: syntheticDigest(21),
          before: null,
          after: p2 as unknown as Record<string, unknown>,
          provenance: { method: "assistant_consolidation" },
        },
      ],
    },
    {
      id: "mtg-weekly-design-draft",
      revision: 1,
      digest: syntheticDigest(31),
      profile: p3,
      history: [
        {
          revision: 1,
          operation: "create",
          actor: "user:design-preview",
          at: Date.parse("2026-11-11T05:00:00Z"),
          digest: syntheticDigest(31),
          before: null,
          after: p3 as unknown as Record<string, unknown>,
          provenance: { method: "screen_form" },
        },
      ],
    },
    {
      id: "mtg-oct-vendor-archive",
      revision: 2,
      digest: syntheticDigest(42),
      profile: p4,
      history: [
        {
          revision: 1,
          operation: "create",
          actor: "user:mei-preview",
          at: Date.parse("2026-10-20T07:00:00Z"),
          digest: syntheticDigest(41),
          before: null,
          after: p4 as unknown as Record<string, unknown>,
          provenance: { method: "screen_form" },
        },
        {
          revision: 2,
          operation: "update",
          actor: "user:mei-preview",
          at: Date.parse("2026-10-28T10:15:00Z"),
          digest: syntheticDigest(42),
          before: p4 as unknown as Record<string, unknown>,
          after: p4 as unknown as Record<string, unknown>,
          provenance: { method: "followup_toggle" },
        },
      ],
    },
  ];
}
