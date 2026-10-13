// Catalog / contract fixtures. The lean tasks and the plan task stay
// non-executable placeholders. software-bounds and software-intervals are the
// executable contracts: each workspace.commit identifies the pinned local bundle
// in packages/agent-adapters/task-assets/<task id> (see ADR 0021).
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { loadSoftwareBundle } from "./software-bundle.mjs";
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
// software-bounds runs from a pinned local bundle, not from a clone: repo is
// only the placeholder URL the schema requires and nothing is fetched from it.
// The shared base object is not mutated, so the Lean contracts keep their hashes.
const software = structuredClone(base);
const bundle = await loadSoftwareBundle();
const testCommand = "node --experimental-strip-types --test tests/search.test.ts";
Object.assign(software, {
  description:
    "Artan sıralı bir sayı dizisinde values[i] >= target koşulunu sağlayan ilk indeksi (yoksa dizi uzunluğunu) döndüren lowerBound fonksiyonunun sınır koşullarını düzelt.",
  prompt:
    "src/search.ts içindeki lowerBound(values, target) fonksiyonunu düzelt. values artan sıralı bir sayı dizisidir ve tekrar eden değerler içerebilir. Fonksiyon values[i] >= target koşulunu sağlayan ilk i indeksini döndürür; böyle bir indeks yoksa values.length döndürür. Boş dizide sonuç 0'dır; hedef tüm değerlerden büyükse sonuç values.length'tir. Diziyi değiştirme. Kaynakta child_process, node:fs ve process.exit ifadeleri bulunmamalıdır. Yalnızca src/search.ts dosyasını düzenle, test dosyalarını değiştirme.",
  workspace: { ...base.workspace, commit: bundle.ids.commit },
  environment: {
    image: "node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392",
    cpu: 1,
    memory_mb: 256,
    time_limit_sec: 1200,
  },
  verification: {
    ...base.verification,
    local_precheck: testCommand,
    server_command: testCommand,
    forbidden_patterns: ["child_process", "node:fs", "process.exit"],
  },
  progress: {
    milestones: [
      { ...base.progress.milestones[0], check: `node --experimental-strip-types --test --test-name-pattern="empty array|below every value|above every value" tests/search.test.ts` },
      { ...base.progress.milestones[1], check: "node --experimental-strip-types --test --test-name-pattern=duplicates tests/search.test.ts" },
    ],
  },
});
// software-intervals: the second pinned catalog task, appended after the
// existing contracts so lean, bounds and plan keep their hashes. Same project,
// image, limits and forbidden patterns as software-bounds.
const intervalsBundle = await loadSoftwareBundle("software-intervals");
const intervalsCommand = "node --experimental-strip-types --test tests/intervals.test.ts";
const intervals = structuredClone(software);
Object.assign(intervals, {
  id: "software-intervals",
  title: "Aralık birleştirme",
  description:
    "Kapalı tamsayı aralıklarını birleştiren mergeIntervals fonksiyonunu düzelt: çakışan ve birbirine değen aralıklar birleşir, sonuç start değerine göre sıralı yeni bir dizidir ve girdi değiştirilmez.",
  prompt:
    "src/intervals.ts içindeki mergeIntervals(intervals) fonksiyonunu düzelt. intervals, [start, end] biçiminde güvenli tamsayı çiftlerinden oluşan kapalı aralıkların dizisidir; her çift için start <= end olur ve sıra keyfidir. Fonksiyon çakışan ve birbirine değen aralıkları birleştirir ([1, 3] ile [3, 5] birleşip [1, 5] olur; ortak noktası olmayan [1, 2] ile [3, 4] ayrı kalır), başka bir aralığın içinde kalan aralıkları da doğru ele alır ve start değerine göre artan sıralı YENİ bir dizi döndürür. Boş girdide [] döner. Girdi dizisini ve içindeki çiftleri değiştirme. Kaynakta child_process, node:fs ve process.exit ifadeleri bulunmamalıdır. Yalnızca src/intervals.ts dosyasını düzenle, test dosyalarını değiştirme.",
  strategies: [
    {
      id: "sort-first",
      instructions:
        "Önce aralıkları girdiyi değiştirmeden bir kopya üzerinde start değerine göre sayısal olarak sırala; ardından tek geçişte her aralığı son birleştirilen aralıkla karşılaştır.",
    },
    {
      id: "sweep",
      instructions:
        "Uç noktaları tek bir tarama ile işle: açık aralık sayısını izle, aynı koordinatta başlangıçları bitişlerden önce işle ve sayaç sıfıra indiğinde birleşik aralığı kapat.",
    },
  ],
  workspace: {
    ...base.workspace,
    commit: intervalsBundle.ids.commit,
    entry_files: ["src/intervals.ts", "tests/intervals.test.ts"],
    writable_paths: ["src/intervals.ts"],
  },
  verification: {
    ...software.verification,
    local_precheck: intervalsCommand,
    server_command: intervalsCommand,
  },
  node_id: "merge-intervals",
  progress: {
    milestones: [
      { ...base.progress.milestones[0], id: "touching", name: "Değen aralıklar", check: `node --experimental-strip-types --test --test-name-pattern="touching|disjoint" tests/intervals.test.ts` },
      { ...base.progress.milestones[1], id: "containment", name: "İç içe aralıklar", check: `node --experimental-strip-types --test --test-name-pattern="contained|not modified" tests/intervals.test.ts` },
    ],
  },
});
const tasks = [lean, software, plan, intervals].map((task) => ({
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
console.log(`${tasks.length} hashed contract fixtures written; software-bounds commit ${bundle.ids.commit}, software-intervals commit ${intervalsBundle.ids.commit}.`);
