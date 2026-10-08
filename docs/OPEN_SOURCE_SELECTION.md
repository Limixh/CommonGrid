# CommonGrid — Açık kaynak bileşen seçimi

Tarih: 2026-10-08 · Durum: Kullanıcı tarafından kabul edilen bileşen tercihleri; koşullu adaylar teknik kabul bekliyor. Entegrasyon veya fizibilite kanıtı değildir.

Kullanıcının paylaştığı 18 aday mevcut spec, yol haritası ve Faz 0 uygulamasıyla karşılaştırıldı. Amaç tamamlanmış v1 kapsamını koruyarak tekrar yazılacak altyapı işini azaltmak. Projelerin resmi depoları, belgeleri ve SWE-ReX'in Docker/runtime kaynakları incelendi; performans veya güvenlik benchmark'ı çalıştırılmadı.

## Seçim

| Aday | Öneri | CommonGrid'deki yeri ve koşulu |
|---|---|---|
| [Tauri 2](https://github.com/tauri-apps/tauri) | Devam | Mevcut Rust/React masaüstü temeli korunur. |
| [Lean 4](https://github.com/leanprover/lean4) + [Mathlib](https://github.com/leanprover-community/mathlib4) | Devam | Matematik doğrulayıcısı; sabit hedef, axiom denetimi ve temiz doğrulama sarmalayıcısı bizim sorumluluğumuz. |
| [Temporal](https://github.com/temporalio/temporal) | Tercih kabul edildi; F0 Windows denemesi geçti | Go sunucusunda kesinti sonrası süren iş akışları, zamanlayıcılar ve kontrollü retry. Production entegrasyonu staging işletim/maliyet kapısını bekler. |
| [SWE-ReX](https://github.com/SWE-agent/SWE-ReX) | Sabit kaynak incelendi; canlı F0 denemesi bekliyor | Shell oturumu, dosya işlemi ve yerel/uzak runtime arabirimi. Değiştirilmemiş resmi CLI araçlarının bu arabirime güvenli yönlendirilmesi ayrıca kanıtlanmalı. |
| [gVisor](https://gvisor.dev/docs/) | Linux runtime adayı | Görev kodunun host kernel saldırı yüzeyini azaltma. Lean derleme, dosya I/O ve yazılım testleriyle uyumluluk/maliyet ölçülmeli. |
| [Kata Containers](https://github.com/kata-containers/kata-containers) | Sunucu doğrulayıcısı için koşullu aday | VM sınırı isteyen worker havuzu. Hosting ortamının sanallaştırma desteği ve işletme maliyeti karar girdisidir. Gönüllü cihazlarının varsayılan kurulum bağımlılığı yapılmaz. |
| [Firecracker](https://github.com/firecracker-microvm/firecracker/blob/main/README.md) | Şimdilik ertelensin | Linux/KVM microVM katmanı. Kendi VM yöneticimizi geliştirmek ek iş çıkarır; mevcut runtime seçimleriyle karşılanmayan ihtiyaç oluşursa yeniden değerlendirilir. |
| [Argo Workflows](https://github.com/argoproj/argo-workflows) | Temporal seçilirse ertelensin | Kubernetes DAG işleri için faydalı; aynı yaşam döngüsünü iki workflow motoruna bölmekten kaçınalım. Doğrulama çalıştırıcısı ilk tasarımda Kubernetes Job kullanabilir. |
| [OPA](https://www.openpolicyagent.org/docs) | F2 politika katmanı adayı | Roller, izin verilen imajlar, ağ ve kaynak politikaları. Policy interface şimdi tanımlanır; schema/hash ve Rust/OS kaynak sınırları ayrı kalır. |
| [Cosign](https://github.com/sigstore/cosign) | F1–F2'de kullan | Platform imajlarının imza doğrulaması. Digest ile birlikte beklenen imzalayan kimliği/issuer veya güvenilen anahtar sabitlenir. |
| [Trivy](https://github.com/aquasecurity/trivy) | F1–F2'de kullan | İmaj, bağımlılık, yapılandırma ve secret taraması. Artifact arşivleri güvenli açılır; tarayıcı izole çalışır ve kaynak limitlerine tabidir. |
| [Gitleaks](https://github.com/gitleaks/gitleaks) | İsteğe bağlı ikinci tarayıcı | Yerel Git/dosya/stdin secret taraması. Güncel README yeni özellik almadığını, güvenlik düzeltmeleriyle süreceğini belirtiyor. İlk entegrasyonda Trivy yeterli aday; iki tarayıcı zorunluluğu benchmark sonucuna bağlı. |
| [Semgrep CE](https://github.com/semgrep/semgrep) | F3'te koşullu kullan | Yazılım patch'leri için kendi kurallarımız veya uygun lisanslı kurallar; bulgular inceleme sinyali olur. Açık kaynak motor bütün ticari özellikleri veya hazır kuralların ürün içinde kullanım hakkını kapsamıyor. |
| [libgit2](https://github.com/libgit2/libgit2) / [git2-rs](https://github.com/rust-lang/git2-rs) | F1 / F4 için aday | Rust'ta clone, tree ve diff işlemleri; desktop dağıtımında sistem Git'ine bağımlılığı azaltabilir. İhtiyaç duyulan Git özellikleri, symlink/path ve artifact sınırları test edilmeli. |
| [Tree-sitter](https://github.com/tree-sitter/tree-sitter) | Context ihtiyacı belirince | Sözdizimi ağacından dosya/fonksiyon bağlamı çıkarma; semantik doğruluk veya başarılı ayrıştırma ispatı sağlamaz. İlk editör için ikinci bir analiz katmanı zorunlu değil. |
| [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) / [SWE-agent](https://github.com/SWE-agent/SWE-agent) | Referans / benchmark | Repo → deneme → patch → test akışını ve deney harness'ini incele. Ortak ürünün görev/lease/puan motorunun yerine koyma. |
| [OpenTelemetry](https://opentelemetry.io/docs/) | F1'den itibaren kullan | API, kiralama ve doğrulama izlerini ortak kimliklerle takip et. Prompt, ham ajan logu, token ve checkpoint içeriği trace attribute'u yapılmaz. |
| [BOINC](https://github.com/BOINC/boinc/wiki/Computing-with-boinc) | Mimari referans | Workunit, yeniden dağıtım, sonuç doğrulama ve katkı puanı deneyimi. CommonGrid'in abonelik/CLI ve insan incelemesi akışı ayrıca tasarlanır. |

## Temporal ile önerilen sunucu düzeni

Go koordinatör görev sözleşmesi, kullanıcı onayı, atomik bütçe rezervasyonu, lease ve aday/inceleme durumlarının yetkili sahibi olmaya devam eder. PostgreSQL bu domain kayıtlarını saklar. Temporal sunucu tarafındaki uzun süren akışları yürütür; görev üretme ve hangi dalın daha fazla kapasite alacağını belirleme algoritması CommonGrid'de kalır.

Önerilen birim, deneme/kiralama başına workflow'dur. Desktop HTTP/WSS üzerinden koordinatöre olay iletir; son kullanıcı cihazını Temporal worker'ı olarak kaydetmek gerekmez. Koordinatör olayları doğruladıktan sonra workflow'a aktarır. Checkpoint'in kendisi nesne depolamada, workflow'da yalnız kimlik/hash/referansı bulunur.

Temporal Activity tekrar çalışabilir; sonuç, checkpoint, doğrulama başlatma ve puan işlemlerimiz idempotent olmalı. Activity heartbeat'i kullanıcı lease heartbeat'iyle aynı kabul edilmez. Sunucunun retry kararı durdurulmuş CLI'ı yeniden başlatmak veya kullanıcı kapasitesini yeniden harcamak için onay sayılmaz. Sunucu akışının toparlanması ile masaüstü süreç belleği/çalışma alanının devralınması ayrı mekanizmalardır.

Tercih spec §7.5/§14 ve yol haritası F0–F2'ye işlendi; production entegrasyonu F0 ve staging kabulüne bağlıdır. Redis'in görev akışının kalıcı sahibi olması gerekmez; önbellek ve hız sınırlama için kullanılabilir. Temporal + Kubernetes Job ile başlanır. Koordinatör domain değişikliği ve Temporal olay teslimi PostgreSQL transaction outbox'ıyla bağlanır; tekrar teslim ve Activity yan etkileri idempotent işlenir. Özel retry/zamanlayıcı işleri azalır, domain ve bütçe kontrolleri korunur.

Kaynaklar: [Go workflow mesajlaşması](https://docs.temporal.io/develop/go/workflows/message-passing), [Activity temelleri](https://docs.temporal.io/develop/go/activities/basics), [Activity execution](https://docs.temporal.io/activity-execution).

## SWE-ReX ve izolasyon kararı

[Runtime arabirimi](https://github.com/SWE-agent/SWE-ReX/blob/main/src/swerex/runtime/abstract.py) shell/dosya işlemleri için incelenmeye değer. [Python paket tanımı](https://github.com/SWE-agent/SWE-ReX/blob/main/pyproject.toml) ek bir Python çalışma zamanı bağımlılığı getiriyor; Rust/TypeScript masaüstüne paketleme, güncelleme ve imza maliyeti hesaba katılmalı.

[Docker deployment kaynağı](https://github.com/SWE-agent/SWE-ReX/blob/main/src/swerex/deployment/docker.py) runtime API'sini port üzerinden açıyor ve ek Docker argümanları alıyor. İncelenen web snapshot'ı ile canlı main kaynaklarının satırları farklıydı; kabul denemesinde bir commit sabitlenmeli. Network-off görev ortamı, erişimi sınırlandırılmış kontrol kanalı, kaynak limitleri ve ayrı kimlik alanı CommonGrid tarafından uygulanmalı. Varsayılan ayarlar güvenlik sözleşmemizin yerine geçmez.

Önce kontrollü ve gerçek kimlik bilgisi içermeyen test: dosya oku/yaz, shell, timeout, iptal, temiz artifact ve daemon erişim sınırı. Ardından resmi CLI araçları bu runtime'a yönlendirilebiliyor mu araştırılır. CLI'ın kendi dosya/komut araçları bu sınırı aşabiliyorsa SWE-ReX'i eklemek kapıyı geçirmez. Gerçek hesap denemesi mevcut spike'taki kimlik kriterleriyle yapılır.

gVisor veya Kata da task'a bağlanan kimlik dosyasını sihirli biçimde gizlemez. CLI/auth güven sınırı, task runtime'ının kernel/VM izolasyonundan bağımsızdır. [gVisor güvenlik modeli](https://gvisor.dev/docs/architecture_guide/security/) ve [Kata platform gereksinimleri](https://github.com/kata-containers/kata-containers#platform-support) bu kararın farklı girdileridir.

## Listeye eklemek istediğim IDE bileşenleri

| Bileşen | Kullanım | Kabul koşulu |
|---|---|---|
| [Monaco Editor](https://github.com/microsoft/monaco-editor) | Kod ve diff editörü | Tauri CSP/worker uyumu, yalnız izinli workspace dosyaları. VS Code eklentileri otomatik çalışmaz; Lean dil servisi ayrıca bağlanır. |
| [xterm.js](https://github.com/xtermjs/xterm.js) | Sandbox terminalinin ekranı | Terminal I/O yalnız task oturumuna bağlanır; host shell yetkisi verilmez. |
| [React Flow](https://github.com/xyflow/xyflow) | AND/OR arama ağacı ve görev DAG'ı | Sunucudaki graph/state verisini gösterir; görsel düzenleme tek başına görev durumunu değiştirmez. |

Bu üç bileşen editör, terminal render'ı ve grafiği sıfırdan yazma ihtiyacını azaltır. Mevcut React/Tauri uygulamasıyla birlikte kullanılabilir.

## Lisans ve ürün kapsamı notları

[Semgrep'in resmi lisans sayfası](https://docs.semgrep.dev/licensing) CE motorunun LGPL-2.1 olduğunu, kendi hazır kural deposunun ise Semgrep Rules License altında farklı ürün/SaaS kısıtları taşıdığını açıklıyor. Entegrasyonda motor, kural ve ücretli analiz özelliği ayrı envanterlenmeli. "GitHub'da açık" ifadesi bütün bu parçalar için aynı izin anlamına gelmez.

[libgit2](https://github.com/libgit2/libgit2#license) GPLv2 + linking exception, [Rust binding](https://github.com/rust-lang/git2-rs) MIT/Apache-2.0 olarak sunuluyor. Binary dağıtımında üçüncü taraf bildirimleri ve kullanılan sürümlerin lisansları kaydedilmeli. Bu belge CommonGrid'in kendi lisansını seçmez.

## Sonraki teknik denemeler

1. F0'da iki bağımsız küçük deneme: Temporal kesinti/yeniden başlatma/retry testi ve SWE-ReX runtime/CLI yönlendirme araştırması. Mevcut kimlik izolasyonu GO kapısı korunur.
2. F1–F2'de imaj yayın/çalıştırma zincirine Cosign + Trivy; API ve doğrulayıcıya OpenTelemetry. İmza, politika ve tarama sonuçları gerçek çalışma imajı digest'ine bağlanır.
3. F1–F3'te Monaco + xterm.js; graph ihtiyaçları hazır olduğunda React Flow. Terminal/editor erişimi sandbox kapısına tabidir.
4. Verifier kabul testinde aynı Lean/yazılım görevleriyle gVisor ve hosting destekliyorsa Kata: kurulum, uyumluluk, derleme süresi, RAM, I/O, iptal ve saldırı paketi karşılaştırılır.
5. Kabul edilen tercihler spec ve yol haritasına birlikte işlendi. Deneme sonuçları implementation ve staging kararlarını günceller; v1 ürün kabul kriterleri korunur, henüz ölçülmeyen takvim kazancı taahhüt edilmez.

## İlk uygulama sonucu

2026-10-08 Windows x64: `spike/temporal` içinde altı SDK testi ve gerçek development server recovery denemesi geçti. Worker ve sunucu checkpoint sonrasında kapatılıp aynı SQLite kaydıyla yeniden açıldı; state geri geldi. Eski hash, Activity effect sonrası retry, tek fixture kaydı, deadline ve iptal sınandı. SDK 1.49.0 / CLI 1.9.1 sabitlendi. Production deployment ve maliyet kabulü ayrıca bekliyor.

`spike/cli-routing` altı Codex/SWE-ReX kaynak hash'ini doğruladı; canlı engine bulunmadığı için runtime ve kimlik kapısı `not_evaluated`. SWE-ReX kurulmadı/çalıştırılmadı, model veya gerçek hesap çağrılmadı. Kod, kanıt ve kapsam sınırları `spike/adr/0002-open-source-and-workflows.md` ve `docs/DEVELOPMENT.md` içindedir.
