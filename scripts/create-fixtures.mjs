// Explicitly non-executable fixtures for catalog / contract parity tests.
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
const root = new URL("../", import.meta.url);
const base = {
  schema_version: "1.0",
  id: "software-bounds",
  task_version: 1,
  project_id: "runtime-lab",
  type: "software",
  kind: "solve",
  title: "İkili aramada sınır koşulları",
  description:
    "Sıralı bir dizide ilk eşleşen öğeyi bulan lower_bound fonksiyonunun sınır koşullarını düzelt.",
  prompt:
    "src/search.ts içindeki lower_bound fonksiyonunu düzelt. Boş dizi, tekrar eden değerler ve bulunamayan hedefler için mevcut testleri geçir. Test dosyalarını değiştirme.",
  strategies: [
    {
      id: "invariant",
      instructions:
        "Yarı açık [lo, hi) aralığının invariantını koru; önce en küçük karşı örneği bul.",
    },
    {
      id: "boundary-first",
      instructions:
        "Önce boş dizi ve uç değerleri incele, ardından tekrar eden değerleri ele al.",
    },
  ],
  workspace: {
    repo: "https://example.com/commongrid-fixtures.git",
    commit: "0".repeat(40),
    entry_files: ["src/search.ts", "tests/search.test.ts"],
    writable_paths: ["src/search.ts"],
  },
  environment: {
    image: "commongrid/software-fixture@sha256:" + "0".repeat(64),
    cpu: 2,
    memory_mb: 2048,
    time_limit_sec: 1800,
  },
  verification: {
    profile: "software-tests",
    local_precheck: "npm test",
    server_command: "npm test",
    output_schema: "software-diff/1.0",
    forbidden_patterns: [],
  },
  depends_on: [],
  difficulty: "medium",
  node_id: "search-bounds",
  parallelism: { mode: "exclusive", initial: 1, cap: 1 },
  agents: { preferred: ["codex"], excluded: [] },
  progress: {
    milestones: [
      {
        id: "edges",
        name: "Sınır koşulları",
        check: "npm test -- edges",
        weight: 0.4,
        critical: true,
      },
      {
        id: "duplicates",
        name: "Tekrarlayan değerler",
        check: "npm test -- duplicates",
        weight: 0.6,
        critical: true,
      },
    ],
  },
  review: { policy: "maintainer", required_approvals: 1 },
  reward_points: 120,
  handoff: {
    enabled: true,
    checkpoint_interval_sec: 300,
    max_checkpoints: 5,
    allow_workspace_snapshot: true,
    resume_from_latest: true,
  },
};
const lean = structuredClone(base);
Object.assign(lean, {
  id: "lean-add-comm",
  project_id: "proof-lab",
  type: "lean",
  title: "Doğal sayılarda toplama değişmeliliği",
  description:
    "Her a b : Nat için a + b = b + a teoremini, sabitlenmiş hedef tanımını değiştirmeden ispatla.",
  prompt:
    "Challenge.lean içindeki add_comm hedefini Nat tümevarımıyla ispatla. Yeni aksiyom, sorry veya hedef değişikliği kabul edilmez.",
  node_id: "nat-add-comm",
  difficulty: "easy",
  reward_points: 100,
  strategies: [
    {
      id: "induction",
      instructions:
        "İlk değişkende tümevarım yap; sıfır ve ardıl yardımcı lemmalarını kullan.",
    },
  ],
  workspace: {
    ...base.workspace,
    entry_files: ["Challenge.lean", "Main.lean"],
    writable_paths: ["Main.lean"],
  },
  environment: {
    ...base.environment,
    image: "commongrid/lean-fixture@sha256:" + "0".repeat(64),
    memory_mb: 4096,
  },
  verification: {
    profile: "lean-proof",
    local_precheck: "lake build",
    server_command: "commongrid-lean-check Main.lean",
    output_schema: "lean-artifact/1.0",
    forbidden_patterns: ["sorry", "axiom"],
  },
  parallelism: { mode: "independent", initial: 3, cap: 10 },
  progress: {
    milestones: [
      {
        id: "base",
        name: "Taban durumu",
        check: "zero_add",
        weight: 0.3,
        critical: true,
      },
      {
        id: "step",
        name: "Tümevarım adımı",
        check: "succ_add",
        weight: 0.7,
        critical: true,
      },
    ],
  },
});
const plan = structuredClone(lean);
Object.assign(plan, {
  id: "lean-plan",
  kind: "plan",
  node_id: "nat-root",
  title: "İspatı alt hedeflere ayır",
  difficulty: "hard",
  description:
    "Doğal sayı aritmetiği hedefi için doğrulanabilir bir ayrıştırma öner.",
  prompt:
    "Açık alt hedefler ve bağımlılıklar öner. Bağlantı ispatını alt hedef hipotezleriyle yaz; kök hedefi değiştirme.",
  verification: {
    profile: "planner-proposal",
    local_precheck: "commongrid-proposal-check proposal.json",
    server_command: "commongrid-proposal-check proposal.json",
    output_schema: "planner-proposal/1.0",
    forbidden_patterns: [],
  },
  progress: { milestones: [] },
});
const tasks = [lean, base, plan].map((task) => ({
  ...task,
  contract_hash: createHash("sha256").update(canonicalize(task)).digest("hex"),
}));
const envelope = {
  source: "fixture",
  execution_enabled: false,
  projects: [
    {
      id: "proof-lab",
      title: "İspat atölyesi",
      type: "lean",
      description:
        "Lean görev sözleşmeleri ve ayrıştırma akışının geliştirme kataloğu.",
    },
    {
      id: "runtime-lab",
      title: "Algoritma atölyesi",
      type: "software",
      description:
        "Bağımsız testlerle doğrulanacak yazılım görevlerinin geliştirme kataloğu.",
    },
  ],
  tasks,
};
const json = JSON.stringify(envelope, null, 2) + "\n";
for (const relative of [
  "packages/task-schema/fixtures/catalog.json",
  "services/coordinator/internal/catalog/catalog.json",
]) {
  const url = new URL(relative, root);
  await mkdir(new URL("./", url), { recursive: true });
  await writeFile(url, json);
}
console.log("3 non-executable, hashed contract fixtures written.");
