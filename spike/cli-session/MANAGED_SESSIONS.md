# İzole resmi oturum kabul denemesi

F0 geliştirici komutlarıdır; gerçek hesap işlemleri CI'a bağlı değildir. Windows native açık oturum ayrı Linux ortamına otomatik geçmez. Auth yalnız resmi CLI tarafından private Docker hacminde yönetilir. Şifre/token/authorization code'u sohbete veya proje dosyasına koymayın.

2026-10-08'de iki yeni resmi giriş ve iki gerçek kodlama görevi geçti: her aday fresh readonly verifier'da 32 örnek ve `git apply --check` geçti. Codex managed refresh isteği ve iki izole profile logout da doğrulandı. Test profilleri artık oturumsuzdur; yeni gerçek görev için resmi login gerekir. Native Windows oturumlarına logout uygulanmadı. Tek kontrollü görev F1 GO değildir.

## Hazırlık ve giriş

```powershell
npm run install:cli-fixtures
npm run spike:routing
npm run spike:managed-session -- prepare claude
npm run spike:managed-session -- prepare codex
```

Her komut farklı bir session UUID verir. Aşağıdaki `CLAUDE_UUID` / `CODEX_UUID` yerlerine çıktıyı yazın. Hazırlık public ikiliyi bir defa kopyalar; sonraki start salt okunur cache'den çalışır. State `.local/managed-session/<uuid>.json` yalnız metadata içerir. İki private home ve iki public tools hacmi kasıtlı korunur.

```powershell
npm run spike:managed-session -- login claude CLAUDE_UUID
npm run spike:managed-session -- login codex CODEX_UUID
```

Claude komutunu **interaktif kullanıcı terminalinde** çalıştırın; CLI'ın verdiği resmi URL/giriş kodu akışını terminalde tamamlayın. Codex komutu resmi device URL ve kısa ömürlü kod gösterir; kullanıcı kendi hesabıyla tarayıcıda tamamlar. Device auth hesap/workspace ayarında kapalıysa resmi OpenAI ayarından etkinleştirmek gerekir. Login komutu başarıyla bitmeden sonraki aynı-provider komutuna geçmeyin. Aynı profile paralel işlem reddedilir.

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
npm run spike:managed-session -- logout codex CODEX_UUID
npm run spike:managed-session -- logout claude CLAUDE_UUID
```

Boundary sahte canary ve public TLS ile 16 kontrol çalıştırır; gerçek credential içeriği okumaz. Gerçek task yalnız sabit `sumIntegers` kabul görevidir. Oturum yoksa model çağrısından önce durur; ücretli API fallback yapmaz. Yeni işlev testleri Codex için `gpt-6-luna`/low, Claude için `haiku` ister. Native smoke hesabın varsayılan/ilk modelini seçmez; Luna yoksa durur. Claude'un açık fallback seçimi aynı Haiku modelidir. Model/profil bulunması kullanıcı hesabında erişim kanıtı değildir. Önceki Astra/Sonnet gerçek görev raporları tarihli kanıt olarak korunur. Gerçek görev raporu `.local/managed-task/<run>/report.json`, patch `artifact/candidate.patch` olur. Aday yeni readonly/network-none verifier'da kontrol edilir.

Codex `refresh` resmi `account/read {refreshToken:true}` yoludur; token byte'ları okunarak rotation ölçülmez. `logout` yalnız seçili izole profile uygulanır ve resmi status kontrol edilir. Session raporu cleanup sonucunu da içerir. Claude için bir resmi force-refresh komutu iddia edilmez; `refresh claude` bilinçli hata verir. Doğal token expiry ve sonraki gerçek turn/relogin ayrı kabul testi olarak bekler. Host native credential dosyaları bu komutların girdisi değildir.

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

`spike:coding-verifier` deterministik tek `sum.mjs` fixture'ıdır. Unsafe inventory/file türleri ve bilinen credential biçimleri export/staging/diff yazımından önce reddedilir. Patch yeni baseline'a uygulanır; uygulanan kaynak hash'i verifier adayına eşit olmalıdır. Bu politika genel repository importer veya production secret scanner değildir.

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

Claude için provider `claude` seçilir. Önceden hazırlanmış public profile manifesti ve resmi kullanıcı girişi gerekir; komut kendiliğinden login/logout veya model çağrısı yapmaz. Status → namespace restart → status, Codex için resmi refresh → status → `account/rateLimits/read` sırası uygulanır. Claude için force-refresh/kota metodu varsayılmaz. Import sırasında CLI başlatılmaz; fixture'lar hesap olmadan çalışır. Gerçek hesap komutu CI'a bağlı değildir ve bu aşamada çalıştırılmadı.

Checkpoint profile/provider ve zamanlarla bağlı sınırlı metadatadır; credential içermez. Resume aralığı doğal token yenilemesi kanıtı olmaz. Kota `available` değeri bilginin okunabildiğini ifade eder; kullanılabilir bakiye garantisi değildir. Desteklenmeyen/bildirilmeyen bilgiler `unknown` kalır. Deadline/iptal ve cleanup ayrı sınırlar taşır; hâlâ bekleyen işlem varken cleanup kesinleşmiş sayılmaz. Ayrıntılar [ADR 0008](../adr/0008-session-continuity-quota-and-operation-fencing.md) içindedir.

Güncel kabul sırası ve geliştirme sınırı [ADR 0012](../adr/0012-go-gate-priority-and-development-boundaries.md) içinde. Önce F0 auth/yenileme ve normal kullanımda kota gözlemleri tamamlanır; kota kasıtlı tüketilmez. Ucuz test modeli kullanılamazsa test durur. Desktop/API `execution_enabled=false`, tam izolasyon kapısı `not_evaluated` kalır.
