# İzole resmi oturum kabul denemesi

F0 geliştirici komutlarıdır; gerçek hesap işlemleri CI'a bağlı değildir. Windows native açık oturum ayrı Linux ortamına otomatik geçmez. Auth yalnız resmi CLI tarafından private Docker hacminde yönetilir. Şifre/token/authorization code'u sohbete veya proje dosyasına koymayın.

2026-10-08'de iki yeni resmi giriş ve iki gerçek kodlama görevi geçti: her aday fresh readonly verifier'da 32 örnek ve `git apply --check` geçti. Codex managed refresh isteği ve iki izole profile logout da doğrulandı. Bu tarihli Sonnet/Astra profilleri logout durumundadır. Native Windows oturumlarına logout uygulanmadı. Tek kontrollü görev F1 GO değildir.

2026-10-09 ilk yerel kabulünde yeni profillerle Haiku gerçek görev/diff/32 örneklik verifier/cleanup geçti; ilk Luna model seçimi doğrulandı fakat aday baseline olarak kaldı ve verifier başarısız oldu. [İlk sonuç](../results/current-cli-acceptance-windows-2026-10-09.json) değiştirilmez. Aynı Codex profiliyle sonraki tek gerçek Luna görevi üç başarılı callback/exit=0, provider completion, değişmiş aday, diff, eski 32 örneklik verifier ve cleanup üretti; [tanı sonucu](../results/managed-task-luna-diagnostics-windows-2026-10-09.json) ve [patch](../results/managed-task-luna-diagnostics-2026-10-09.patch) bunu ayrı kaydeder.

Sonraki QA bu Luna adayının seyrek dizi slotlarını `every` ile atladığını buldu: `Array(1)` ve `[1,,]` için TypeError yerine RangeError üretiyor. Eski 32 örneklik başarı tarihli kanıttır; güçlü aday kabulü bekler. Verifier aynı 32 JSON örneğine çocuk süreçte kurulan iki gerçek seyrek dizi ekleyerek 34 örneğe çıkarıldı; JSON taşıması boş slotları null'a dönüştürerek hatayı gizleyemez. Olumsuz kontrol eski 32'yi geçer, seyrek dizilerde reddedilir. `70fd7c6` verifier kaynağıyla AI'sız gerçek Docker fixture'ın 25 kontrolü ve cleanup geçti. Özgün Haiku adayının 34 örneklik replay'i geçti; yeni Luna adayı JSON örneklerini geçti, seyrek dizilerde reddedildi. İki replay'in cleanup'ı doğrulandı; [34 örneklik replay ve cleanup kaydı](../results/coding-verifier-sparse-windows-2026-10-09.json) bunları ayrı kaydeder. İlk replay denemesi Docker timeout nedeniyle kabul kanıtı değildir; başarısız kaydı korunur. Yeni iki profil normal sonraki gözlemler için giriş yapmış halde tutuluyor; yeniden login/logout yapılmıyor. Haiku bundled roots ile çalıştı, ek host CA seçilmedi. [ADR 0013](../adr/0013-current-cheap-model-acceptance.md) ilk kabul sınırlarını, [ADR 0014](../adr/0014-task-routing-and-sparse-verifier.md) sonraki araç tanısı ve güçlendirilmiş verifier sonucunu kaydeder.

Güncel managed-task raporlarında `candidate_changed` ve sabit provider completion durumu bulunur. Codex callback'leri yalnız sonuç kategorisi, çıkış kodu ve çıktı byte sayılarıyla kaydedilir; komut ve ham çıktı tutulmaz. Bunlar ilk başarısız Luna koşusuna geriye dönük eklenmez. `f09a592` task araç yönergelerini açıklığa kavuşturdu; AI'sız gerçek Docker preflight yedi kontrol, dosya değişimi ve eski 32 örneklik verifier yolunu sınadı. [Task yönlendirme kaydı](../results/task-routing-diagnostics-windows-2026-10-09.json) model veya hesap kabulü değildir. [Araç yönergelerinin yerel kontrolü](../results/luna-routing-foundations-windows-2026-10-09.json) ile yeni harness'in [yerel kontrolü](../results/coding-verifier-sparse-foundations-windows-2026-10-09.json) ayrı kanıtlardır. GitHub Foundations'ın [32a766d için 11 başarılı job'u](../results/github-foundations-32a766d-2026-10-09.json) sonraki `f09a592` veya 34 örneklik harness'i kapsamaz.

## Hazırlık ve giriş

```powershell
npm run install:cli-fixtures
npm run spike:routing
npm run spike:managed-session -- prepare claude
npm run spike:managed-session -- prepare codex
```

Her komut farklı bir session UUID verir. Aşağıdaki `CLAUDE_UUID` / `CODEX_UUID` yerlerine çıktıyı yazın. Hazırlık public ikiliyi bir defa kopyalar; sonraki start salt okunur cache'den çalışır. State `.local/managed-session/<uuid>.json` yalnız metadata içerir. İki private home ve iki public tools hacmi kasıtlı korunur.

Geçerli hazırlanmış profil sonraki görevlerde aynı UUID ile kullanılır. Host görev yöneticisinin callback tanısı veya prompt'u değiştiğinde yeniden `prepare`/login gerekmez; bunlar public CLI cache'ine kopyalanmaz. Her restore yeni operation UUID üretir; start volume sahipliğini, namespace'in boş olmasını, binary/bridge hash'lerini ve trust içeriğini yeniden kontrol eder. Public bridge/broker veya binary pinleri değişirse mevcut cache kendiliğinden yükseltilmez; bu durum aşağıdaki teknik sınırda ayrıca ele alınır.

```powershell
npm run spike:managed-session -- login claude CLAUDE_UUID
npm run spike:managed-session -- login codex CODEX_UUID
```

Claude komutunu **interaktif kullanıcı terminalinde** çalıştırın; CLI'ın verdiği resmi URL/giriş kodu akışını terminalde tamamlayın. Codex komutu resmi device URL ve kısa ömürlü kod gösterir; kullanıcı kendi hesabıyla tarayıcıda tamamlar. Device auth hesap/workspace ayarında kapalıysa resmi OpenAI ayarından etkinleştirmek gerekir. Login akışı resmi authenticated status ile doğrulanmadan sonraki aynı-provider komutuna geçmeyin. Mevcut geçerli oturumda login gerekli değildir. Aynı profile paralel işlem reddedilir.

## Codex dar profilini doğrulama

Eski `gpt-5.1-codex` fixture güncel gerçek model desteği anlamına gelmez. Kullanıcının test maliyeti tercihiyle `codex-profile.mts`, pinned public katalogdaki `gpt-6-luna` için direct tool / disabled multi-agent / boş experimental tool listesi üretir. Resmi `model_catalog_json` ayarı kullanılır; provider/auth/entitlement değiştirilmez. Önceki Astra profilinin proof'u Luna için geçmez; aşağıdaki hesapsız fixture yeni model/hash ile geçmelidir.

```powershell
$env:CG_FIXTURE_PROVIDER='codex'
$env:CG_FIXTURE_CODEX_MODEL='gpt-6-luna'
$env:CG_FIXTURE_CODEX_DIRECT_PROFILE='1'
$env:CG_FIXTURE_CODEX_TOOLS_OWNER='CODEX_UUID'
npm run spike:cli-session
Remove-Item Env:CG_FIXTURE_PROVIDER, Env:CG_FIXTURE_CODEX_MODEL, Env:CG_FIXTURE_CODEX_DIRECT_PROFILE, Env:CG_FIXTURE_CODEX_TOOLS_OWNER
npm run spike:managed-session -- install-coding-profile codex CODEX_UUID
```

Cache shortcut yalnız sahipliği ve binary hash'i doğrulanmış public tools hacmini readonly bağlar; auth hacmini fixture'a bağlamaz. İsteğe bağlıdır; tools-owner env'ini atlamak binary'yi disposable tmpfs'e kopyalar. Fixture yalnız `functions.task_exec` envanterini kabul eder. Başarılı fixture ve cleanup kaydı olmadan profil kurulmaz veya gerçek Codex görevi başlamaz. Katalog/model bulunması tek başına entitlement kanıtı değildir.

## Sınır, görev ve yenileme

```powershell
npm run spike:managed-boundary -- CLAUDE_UUID CODEX_UUID
npm run spike:managed-adversarial
npm run spike:coding-verifier
npm run spike:managed-task -- claude CLAUDE_UUID
npm run spike:managed-task -- codex CODEX_UUID
npm run spike:managed-session -- refresh codex CODEX_UUID
```

Boundary sahte canary ve public TLS ile 16 kontrol çalıştırır; gerçek credential içeriği okumaz. Gerçek task yalnız sabit `sumIntegers` kabul görevidir. Oturum yoksa model çağrısından önce durur; ücretli API fallback yapmaz. Yeni işlev testleri Codex için `gpt-6-luna`/low, Claude için `haiku` ister. Native smoke hesabın varsayılan/ilk modelini seçmez; Luna yoksa durur. Claude'un açık fallback seçimi aynı Haiku modelidir. Model/profil bulunması kullanıcı hesabında erişim kanıtı değildir. Önceki Astra/Sonnet gerçek görev raporları tarihli kanıt olarak korunur. Gerçek görev raporu `.local/managed-task/<run>/report.json`, patch `artifact/candidate.patch` olur. Aday yeni readonly/network-none verifier'da kontrol edilir.

`task_exec`, `argv` dizisini doğrudan `/task` çalışma dizinindeki ayrı task ortamında çalıştırır; örtük shell veya stdin teslimi yoktur. Digest'i sabitlenmiş Node 22 bookworm-slim imajında dosya okuma/yazma için `["node", "-e", "JavaScript kaynak"]` kullanılabilir. Shell gerekiyorsa `["/bin/sh", "-c", "shell kaynak"]` açıkça seçilir; bu shell task konteynerinde çalışır. Varsayılan timeout 3000 ms'dir; isteğe bağlı `timeout_ms` 1–30000 arasında tam sayıdır. Task ortamı non-root, ağsız ve salt okunur root filesystem ile çalışır; yazılabilir görev hacmi `/task` ile sınırlıdır. Runtime ve model yönergeleri, kurulu olduğu doğrulanmamış başka araçları varsaymaz.

Güncel görev koşulu ilk hatada durmayı da açıkça belirtir: boş slotlar dahil her array pozisyonunu soldan sağa ziyaret et; o değeri toplamaya hemen önce doğrula, ilk safe integer olmayan değerde TypeError üret; her toplama sonrası running sum güvenli değilse hemen RangeError üret. Daha sonraki elemanları önce topluca doğrulamak bu hata sırasını değiştirebilir. Boş array sonucu 0'dır. Sıradaki gerçek kabul, normal Luna kullanımında bu koşulları karşılayan tek değişmiş adayın 34 örneklik bağımsız verifier ve cleanup sonucu olacaktır; mevcut replay aşamasında yeni AI çağrısı yapılmıyor.

Codex `refresh` resmi `account/read {refreshToken:true}` yoludur; token byte'ları okunarak rotation ölçülmez. `logout` yalnız açıkça seçilen izole profile uygulanır ve resmi status kontrol edilir. Normal süreklilik gözlemi için mevcut yeni profillerde logout yapılmaz; gerektiğinde ayrı `npm run spike:managed-session -- logout PROVIDER UUID` komutu kullanılır. Session raporu cleanup sonucunu da içerir. Claude için bir resmi force-refresh komutu iddia edilmez; `refresh claude` bilinçli hata verir. Doğal token expiry ve sonraki gerçek turn/relogin ayrı kabul testi olarak bekler. Host native credential dosyaları bu komutların girdisi değildir.

## Temizlik ve teknik sınır

```powershell
npm run spike:managed-session -- destroy claude CLAUDE_UUID
npm run spike:managed-session -- destroy codex CODEX_UUID
```

`destroy` yalnız seçili owner'ın CLI/auth/tools kaynaklarını kaldırır; broad prune yapmaz. Giriş sonrası profile'ı tekrar kullanmak için hacmi koruyun. CLI namespace'leri komut sonunda kaldırılır; private hacmin kalması cleanup hatası değildir. Host crash durumunda namespace PID1 ömrü 15 dakika ile sınırlıdır; bu production crash recovery kanıtı değildir. Auth hacmi için otomatik retention/şifreleme ve production garbage collection henüz yoktur.

Provider egress sadece exact hostname:443, public IPv4 DNS ve TLS passthrough stdio relay'idir; task ağı `none` kalır. Public tools, bridge kaynakları ve CA eşitliği her start'ta doğrulanır. Varsayılan trust sabit Node imajının bundled root listesidir. Host CA deposu otomatik taranmaz; TLS doğrulaması açık kalır. `install-trust PROVIDER UUID` yalnız güncel public bridge/broker hash'leriyle eşleşen cache'e bu bundled listeyi ekler. Eski bridge/broker cache'ini yükseltmek yeni `prepare` gerektirir.

### İsteğe bağlı, açık seçilmiş Claude TLS root'u

Ek public root yalnız Claude için, kullanıcının PEM ve proof dosyasını birlikte açıkça seçmesiyle kurulur. Windows exporter manuel çalıştırılır: sabit `api.anthropic.com:443` için Windows hostname/zincir doğrulamasını yapar ve yalnız doğrulanmış zincirdeki installed Root sertifikasını dışarı verir. Private key veya host trust deposunun tamamını taşımaz. PowerShell 7 gerekir:

```powershell
./spike/cli-session/export-windows-trust.ps1 -CheckOnly
./spike/cli-session/export-windows-trust.ps1
npm run spike:managed-session -- prepare claude --host-trust-pem ".local/managed-session/claude-windows-root.pem" --host-trust-proof ".local/managed-session/claude-windows-root.proof.json"
```

Henüz ek root seçilmemiş bir profile için alternatif komut:

```powershell
npm run spike:managed-session -- install-host-trust claude CLAUDE_UUID --host-trust-pem ".local/managed-session/claude-windows-root.pem" --host-trust-proof ".local/managed-session/claude-windows-root.proof.json"
```

`--host-trust-pem PATH` ve `--host-trust-proof PATH` birlikte zorunludur; yalnız Claude `prepare` veya `install-host-trust` komutlarında kabul edilir. Seçim sırasında proof en fazla 30 günlük olmalı, sertifika geçerli olmalıdır. Root, profile owner ve sertifika/PEM SHA-256 değerlerini taşıyan metadata ile bağlanır; seçilmiş içerik tools hacmine sabitlenir. Startup bu değişmez içeriği salt okunur hacimden doğrular, host PEM/proof dosyalarını yeniden okumaz. Sertifikanın geçerlilik süresi her startup'ta kontrol edilir; 30 günlük proof sınırı yeni seçim içindir.

Root değiştiğinde neden incelenir ve açık seçimle yeni profile hazırlanır. Mevcut profile'ın root'u sessizce güncellenmez; bu yol genel CA rotation yönetimi değildir. Yerel certificate/proof `.local` altında kalır. 2026-10-08 tarihli Kaspersky HTTPS incelemesi bulgusu önceki makineye ait kanıttır; yeni makinelerin aynı root'u gerektirdiği veya otomatik keşfedileceği anlamına gelmez.

## Hesapsız güvenlik testleri

`spike:managed-adversarial` UUID istemez. Her sağlayıcı için yeni owner ve sentetik private dosya/process oluşturur; eski private profillere erişmez, login/inference yapmaz. Task'ın dosya, `/proc`, fd/env, socket ve ptrace erişimleri; PID/tmpfs tükenmesi; proxy/broker yetkisi, body/çıktı/çağrı sınırları ve deadline/çıktı sonrası namespace teardown sınanır. Kapanışta yalnız bu çalışmanın task/CLI konteynerleri ve yeni auth/tools hacimleri kaldırılır. Tek sağlayıcı için komuta `-- claude` veya `-- codex` eklenebilir. Rapor `.local/managed-adversarial/<run>/report.json` altındadır.

`spike:coding-verifier` tek `sum.mjs` fixture'ıdır. Güncel independent oracle 32 JSON örneği ve iki gerçek seyrek array ile 34 örneği kontrol eder; `json_cases_passed` ve `sparse_cases_passed` ayrı kaydedilir. `every` ile ön doğrulama yapan olumsuz kontrolün eski 32'yi geçip seyrek dizilerde reddedilmesi harness'in yeni hatayı yakaladığını gösterir. Unsafe inventory/file türleri ve bilinen credential biçimleri export/staging/diff yazımından önce reddedilir. Patch yeni baseline'a uygulanır; uygulanan kaynak hash'i verifier adayına eşit olmalıdır. Eski 32 örnekli raporlar değişmez ve yeni 34 örnekli kabul yerine kullanılamaz. Bu politika genel repository importer veya production secret scanner değildir.

Public broker/bridge kaynakları değiştiğinde hash kontrolü eski prepared cache'i başlatmaz. Bu aşama mevcut private profile'ı otomatik yükseltmez; auth taşımadan yeni `prepare` ve gerçek kabul gerekiyorsa resmi login kullanılır. Eski hacimler ancak açık `destroy` komutuyla kaldırılır. Önceki gerçek hesap kayıtları güncel lifecycle koduyla yeniden inference yapıldığı anlamına gelmez.

Genel repository importer/scanner, Claude doğal yenilemesi, tüm adversarial tool/plugin yolları, gerçek kota/eşzamanlılık, diğer hostlar ve ürün provider uyumluluğu bekler. Desktop/API execution kapalıdır. [ADR 0006](../adr/0006-managed-cli-sessions-and-coding-verifier.md) önceki gerçek görev kanıtını, [ADR 0007](../adr/0007-adversarial-control-artifact-and-lifecycle.md) güncel sentetik kabulü ve kalan kapıları tanımlar.

## İşlem sahipliği ve oturum sürekliliği

```powershell
npm run spike:session-continuity
npm run spike:session-continuity -- codex
```

UUID gerektirmez; her sağlayıcı için yeni sentetik profile oluşturup sonunda kaldırır. Altı eşzamanlı contender start, yanlış işlem exec/bridge reddi, sahte state restart, durmuş tam işlem uzlaştırması, eski cleanup'ın yeni oturumu koruması, timeout/iptal sonrası alt süreç teardown ve control/readiness arızaları sınanır. Önceki private profiller, gerçek auth ve inference kullanılmaz. `recoverStopped(expectedOperation)` otomatik crash recovery değildir; yalnız doğrulanmış durmuş konteyneri uzlaştırır. Rapor `.local/managed-continuity/<run>/report.json` içindedir.

Salt okunur resmi hesap kabulü ayrı, açık seçimli geliştirici komutudur:

```powershell
npm run spike:session-acceptance -- codex CODEX_UUID --real-account
npm run spike:session-acceptance -- codex CODEX_UUID --real-account --resume
```

Claude için provider `claude` seçilir. Önceden hazırlanmış public profile manifesti ve resmi kullanıcı girişi gerekir; komut kendiliğinden login/logout veya model çağrısı yapmaz. Status → namespace restart → status, Codex için resmi refresh → status → `account/rateLimits/read` sırası uygulanır. Claude için force-refresh/kota metodu varsayılmaz. Import sırasında CLI başlatılmaz; fixture'lar hesap olmadan çalışır. Gerçek hesap komutu CI'a bağlı değildir. 2026-10-09'da Claude status/restart/status ve checkpoint geçti. Aynı checkpoint 39.933.216 ms, yaklaşık 11 saat 5 dakika sonra resume edildi; yeniden resmi status/restart/status ve cleanup geçti. [Gecikmeli Claude oturum kaydı](../results/managed-session-delayed-claude-windows-2026-10-09.json) model inference içermez; aradaki oturum etkinliği gözlenmediği için bu süre doğal token yenilemesi kanıtı değildir. Codex aynı status/restart aşamalarını geçti; resmi refresh isteği 30 saniyelik deadline ile başarısız oldu, cleanup doğrulandı. Sonraki gerçek Luna task'ında resmi refresh döndü; bu ayrı sonuç önceki runner başarısızlığını değiştirmez. Ayrı resmi salt okunur Codex quota snapshot'ı başarıyla normalleştirildi; değerler public kayda konmaz, kota kasıtlı tüketilmez ve fallback uygulanmaz.

Checkpoint profile/provider ve zamanlarla bağlı sınırlı metadatadır; credential içermez. Resume aralığı doğal token yenilemesi kanıtı olmaz. Kota `available` değeri bilginin okunabildiğini ifade eder; kullanılabilir bakiye garantisi değildir. Desteklenmeyen/bildirilmeyen bilgiler `unknown` kalır. Deadline/iptal ve cleanup ayrı sınırlar taşır; hâlâ bekleyen işlem varken cleanup kesinleşmiş sayılmaz. Ayrıntılar [ADR 0008](../adr/0008-session-continuity-quota-and-operation-fencing.md) içindedir.

Önceki Docker login/fixture koşularındaki cleanup=false kayıtları korunur; yalnız exact container ID ve sahiplik doğrulamasıyla manuel uzlaştırma orphan kaynaklarını kaldırdı. Auth/tools hacimleri korundu. Sonradan yapılan temizlik önceki koşunun cleanup sonucunu değiştirmez.

Güncel kabul sırası ve geliştirme sınırı [ADR 0012](../adr/0012-go-gate-priority-and-development-boundaries.md) içinde. Önce F0 auth/yenileme ve normal kullanımda kota gözlemleri tamamlanır; kota kasıtlı tüketilmez. Ucuz test modeli kullanılamazsa test durur. Desktop/API `execution_enabled=false`, tam izolasyon kapısı `not_evaluated` kalır.
