# ADR 0007 — Kötü niyetli görev, kontrol kanalı ve artifact sınırı

Tarih: 2026-10-08. Durum: **F0 kapsamında uygulandı; GO kararı verilmedi.** Referans ortam Windows x64 host ve Docker Linux/WSL2, digest'i sabit Node 22 Bookworm Slim x86-64 imajıdır. Tamamlanmış v1.0 kapsamı korunur.

## Problem ve karar

Gerçek Claude/Codex görevleri, bağımsız doğrulama, Codex resmi refresh isteği ve izole logout ADR 0006'da kaydedildi. Sonraki kabul işi, görev kodunun özel CLI ortamına erişme girişimlerini ve kontrol protokolünün hatalı/eşzamanlı girdilerini tekrar çalıştırılabilir biçimde sınamaktır. Bu aşamada gerçek hesap veya model çağrısı yapılmaz; yeni sentetik profiller kullanılır ve kapanışta kaldırılır. Önceki oturumsuz private profiller kullanılmaz.

Üç sınır birlikte güçlendirildi:

1. Broker gövde okunmadan önce tek çalışma slotunu ayırır. İstemci execution başladıktan sonra bağlantıyı keserse slot, görev gerçekten bitene kadar tutulur. Bearer doğrulaması, 48 KiB gövde sınırı ve katı UTF-8 çözümü dispatch öncesindedir.
2. Host relay exact frame alanlarını, ready sırasını, kimlikleri, eşzamanlı task/socket/DNS sayısını ve toplam byte/frame/çıktı kuyruğu sınırlarını denetler. İptal edilmiş DNS isteği sonuçlanmadan kapasiteyi serbest bırakmaz; eski isteğin sonucu yeni bağlantıyı sahiplenemez. Soket/pipe backpressure callback'leri kapanışta kaldırılır. Beklenmedik kontrol hatası kalıcı failure oluşturur; yalnız sağlayıcının başarı mesajı kabul sonucu üretemez.
3. `sum.mjs` çıktısı task süreçleri duraklatılmışken, readonly exporter ile tek regular file olarak alınır. Inventory, symlink/hardlink/FIFO, açılan dosyanın kimliği ve değişimi, 16 KiB sınırı, UTF-8/control/bidi ve bilinen credential biçimleri export öncesinde kontrol edilir. Aynı içerik host'ta yeniden denetlenir. Diff yalnız Git metadata başlıklarında normalize edilir; fresh baseline'a gerçekten uygulanır ve uygulanan dosyanın hash'i doğrulanan adayla eşit olmalıdır.

Resmi oturum komutlarında subscription identity, bounded RPC deadline, login completion sırası, callback/thread/turn sahipliği, tekrarlanan kimlikler, iptal ve bağımsız cleanup ortak fixture yardımcılarıyla denetlenir. Provider pipe byte/line sınırı readline'a aktarılmadan uygulanır; newline göndermeyen çıktı da sınırlıdır. Kodlama iptali RPC kapanışından sonra snapshot/verifier/diff/cleanup boyunca kalıcıdır ve başarı kapısında yeniden denetlenir. Sağlayıcı hataları ve reddedilen bağlantı hedefleri sabit kategorilerle raporlanır; ham hata/kimlik/hedef içeriği tutulmaz. Claude'un doğrulanmış logged-out status JSON'u için resmi exit 1 davranışı kabul edilir; diğer nonzero çıkışlar başarı sayılmaz.

## Testte bulunan hatalar

| Bulgu | Uygulanan düzeltme |
|---|---|
| Eşzamanlı eksik HTTP gövdeleri execution slotunu geç alabiliyor | Slot body okunmadan rezerve edilir; disconnect durumu gerçek executor ömrünü izler |
| `connect/close` döngüsü unresolved DNS admission sınırını boşaltabiliyor | Pending DNS için ayrı kapasite ve deadline; cancellation slotu erken düşürmez |
| `write(false)` sonrası soket drain gelmeden kapanırsa sonraki görev frame'leri bekleyebiliyor | Backpressure sahipliği close/error/stop'ta bırakılır; inbound frame akışı devam eder |
| Ters yöndeki drain callback'leri kapanmış soketleri tutabiliyor | Her soket için en fazla bir callback; close/error/stop'ta kaldırılır |
| Beklenen shutdown geç child exit'i failure yapabiliyor; sağlayıcı success kontrol hatasını gizleyebiliyor | Intentional stop ayrılır; beklenmedik failure kalıcıdır ve caller başarı kapısında denetlenir |
| Reddedilen hostname ve DNS hata metni rapora özel içerik taşıyabiliyor | Yalnız kapalı reason code listesi kaydedilir; attacker içerikli domain/hata regression testi vardır |
| Readline newline gelmeden sınırsız satır biriktirebiliyor; RPC dispose sonrası iptal kaybolabiliyor | Pipe girişi raw byte sınırına bağlanır; bağımsız operation cancellation artifact ve cleanup sonuna kadar korunur |
| Git prefix'lerini tüm patch'te değiştirmek adayın string literal'ini bozabiliyor | Yalnız sabit metadata başlıkları değiştirilir; Windows CRLF ayarı pin'lenir, gerçek apply ve hash eşitliği kontrol edilir |
| Projenin ignore edilen `.local` altındaki `git apply --check` dosyayı atlayıp exit 0 dönebiliyor | Apply parent repository keşfinden ayrılır; ignore edilen nested repo regression'ı ve uygulanan dosyanın birebir eşitliği zorunludur |
| File export öncesi veya doğrudan verifier/diff çağrısı güvenli olmayan içerik taşıyabiliyor | Ortak dar politika export, staging ve artifact yazımından önce uygulanır |

## Kabul ve tekrar

```powershell
npm run check
npm run install:cli-fixtures
npm run spike:managed-adversarial
npm run spike:coding-verifier
```

Sentetik saldırı paketi sağlayıcı başına 11 gruptur: ayrı PID/mount/network namespace'leri, UID/capability/readonly/cgroup sınırları, özel dosya/process/fd/env/socket/ptrace/seccomp erişimi, PID/tmpfs tükenmesi, proxy destination reddi, malformed broker ve başka attempt seçimi, task çıktı limiti, 16 çağrı bütçesi ve yan etki reddi, canary/process bütünlüğü, deadline sonrası namespace teardown ve aşırı çıktı sonrası teardown. Private process ve ptrace hedefi sentetik daemon'dur; gerçek credential içeriği okunmaz. Her grup birden fazla assertion içerir; grup sayısı test veya saldırı kapsamının tamamı değildir.

Coding fixture 24 kontrol içerir: bozuk baseline/exit-0 spoof reddi, bounded snapshot, fresh network-none verifier'da private oracle ile 32 örnek, Git apply check/roundtrip/hash eşitliği, path literal korunması ve unsafe inventory/file/content reddi. Gerçek AI adaylarının önceki kaynakları yeni dar politikadan geçirilmiştir; model çağrısı tekrarlanmış sayılmaz.

Önceki Claude/Codex AI patch'leri ayrıca disposable baseline'a gerçekten uygulandı; patch/base hash'leri tarihli raporlara, uygulanan aday hash'leri önceki independent verifier kayıtlarına eşittir. İki kaynak dar politikadan geçti; aday kodu çalıştırılmadı. `artifact-replay-windows-2026-10-08.json` bu yeni replay kanıtıdır; tarihli exit-0 check'in dosyayı gerçekten uyguladığı iddia edilmez.

Pure broker/control/lifecycle/artifact regression testleri genel `npm run check` içine alındı. Ubuntu Docker CI işleri sentetik adversarial ve coding-verifier komutlarını çalıştıracak şekilde genişletildi; gerçek hesap işlemleri CI'a bağlı değildir. Uzak CI bu yerel kayıtla doğrulanmış sayılmaz. Son başarılı raporlar `spike/results` içinde, tüm yerel deneme geçmişi `.local` altındadır.

Son kaynakla yerel sonuç: **Claude 11 + Codex 11 saldırı grubu, coding verifier 24/24 ve genel 121 Node testi geçti.** Go tests/generated/typecheck/frontend/Go build başarılıdır. Owner etiketli test konteyneri kalmadı; sentetik hacimler kaldırıldı. Önceki iki oturumsuz managed profile'a ait dört private hacim korundu. `.local` ignored-path Git skip koşusu failure olarak saklandı; düzeltilmiş ignored nested-repo regression'ı ve final Docker roundtrip geçti. PostgreSQL integration, Temporal, UI ve native release bu değişiklikte yeniden çalıştırılmadı.

## Kalan sınırlar

- Bu bir genel repository/archive importer veya production secret scanner değildir. Bounded credential biçim kontrolü, encode edilmiş veya bilinmeyen her sırrı bulduğunu iddia etmez. Trivy/ayrı scanner ve genel diff/paket açma güvenliği F1/F2 işidir.
- Task workspace volume disk kotası yoktur. CPU/RAM cgroup limitleri incelenmiştir; CPU/OOM stress kabulü yapılmamıştır. PID ve tmpfs tükenmesi fiilen sınanmıştır.
- Docker daemon/kernel/host compromise, tüm provider built-in/MCP/plugin/extension yolları ve macOS/Linux host fizibilitesi bu paketin kapsamında değildir.
- Claude doğal expiry/refresh/relogin, gerçek kota/eşzamanlı abonelik kullanımı, crash recovery ve sağlayıcı/dağıtım uyumluluğu kapanmamıştır. Codex resmi refresh isteği token byte rotation kanıtı değildir.
- Güncel lifecycle/bridge koduyla gerçek auth/inference yeniden denenmemiştir. ADR 0006 kayıtları önceki kodun tarihli kanıtlarıdır. Public bridge hash'i değiştiği için eski prepared cache başlatma sırasında reddedilir; otomatik cache/auth aktarımı veya private profile yükseltmesi yapılmaz. Yeni gerçek kabul için yeni profile hazırlığı ve resmi kullanıcı girişi gerekir.

**Sonuç:** Sentetik sınır ve deterministik artifact kabulü ilerledi. `execution_enabled=false`, `isolation_gate=not_evaluated` ve F1 öncesi GO/GO WITH LIMITATION gereği korunur.
