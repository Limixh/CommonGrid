# ADR 0006 — Ayrı resmi oturum ve bağımsız kod doğrulama hattı

2026-10-08 · **İki sağlayıcıyla kontrollü gerçek görev geçti. F0 kabulü kısmi; GO değildir.**

## Karar

Model A için değiştirilmemiş resmi Linux CLI ayrı, network-none Docker namespace'inde çalışır. UID 1000'a ait özel `/home/node` hacmini yalnız CLI görür. Windows oturum dosyası okunmaz/kopyalanmaz; kullanıcı resmi CLI'ın girişini bu yeni ortamda tamamlar. Auth cache yazılabilir olduğu için sağlayıcının kendi yenilemesi mümkün kalır. CommonGrid token toplamaz veya kendi OAuth/token exchange uygulamasını yazmaz.

Public CLI ve trusted bridge kaynakları ilk hazırlıkta checksum kontrolüyle Docker hacmine aktarılır, çalışırken salt okunur bağlanır. Her açılış binary ve bridge hash'lerini tekrar doğrular. Bu F0 cache'i imzalı ürün paketlemesi değildir. Private auth hacmi açık `destroy` komutuna kadar korunur; boş cache, restart canary ve gerçek auth ayrı kanıtlardır. Auth'ın Docker diskinde saklanması encryption/keychain kabulünü tamamlamaz.

CLI rootfs read-only, cap-drop ALL/no-new-privileges, CPU/RAM/PID sınırlarıyla başlatılır. Host bind mount, Docker socket ve published port yoktur. PID1 ömrü 15 dakika; geliştirici login bekleme süresi 10 dakikadır. Cleanup yalnız owner + operation etiketli kaynakları kaldırır. Aynı profile ikinci komut başarısız olduğunda birinci komutun namespace'ini silemez. Crash/recovery ve production profile locking hâlâ ayrı işlerdir.

CLI loopback HTTP CONNECT köprüsü stdio üzerinden host'taki trusted relay'e ulaşır. Relay yalnız provider'a özel exact hostname + 443'ü kabul eder; IPv4 DNS yanıtlarının tümü public olmalıdır ve bağlantı doğrulanan IP'ye yapılır. HTTP proxy normal HTTP isteği kabul etmez. Relay TLS içeriğini açmaz/kaydetmez. Payload/output/frame/socket sınırları, backpressure ve 16 görev çağrısı sınırı vardır. IPv6 ve kurumsal/private DNS desteklenmiş sayılmaz. Bu Windows hosttaki TLS incelemesi için dar public CA ekinin sınırları aşağıda kaydedilir.

Task UID 65532 ayrı filesystem/PID/network namespace'indedir; auth/cache/tools hacimleri bağlanmaz. Claude strict MCP veya Codex experimental empty environment + dynamic tool aynı kapalı task broker'ına gider. Real task komutu yalnız sabit bir kabul görevi alır; desktop/HTTP'ye ve CI'a bağlı değildir. Ücretli API fallback yoktur. Katalog bulunması entitlement kanıtı değildir.

## Codex model / araç profili

Eski `gpt-5.1-codex` fixture kaydı korunur; model güncel gerçek katalogda yoktu. `gpt-6-astra` metadatası kapatma bayraklarına rağmen code mode, çoklu ajan ve kullanıcı/saat araçlarını etkinleştirdi. Kapalı wire envanteri bu profili reddetti.

Resmi `model_catalog_json` ayarıyla hash'i sabit `rust-v0.157.1` public model kaynağından F0 katalog üretilir. Yalnız `tool_mode=direct`, `multi_agent_version=disabled`, `experimental_supported_tools=[]` değiştirilir. Binary, `openai` provider, managed auth ve model kimliği aynı kalır; entitlement verilmez. Kaynak SHA-256 `0178d235c589a31abd6ed0ea1e870935dc5819240eb0e813e178d3ebedf534f4`, katalog SHA-256 `850a01af776a85af411bb92be923635ef48c09f2b2f475bc5604bd41ea5fe5f6`.

Resmi CLI isteğinde yalnız `functions.task_exec` görüldü; 10 fixture kontrolü ve cleanup geçti. Responses namespace'i ayrı taşır; bare dynamic tool callback'inde CLI namespace `null`, tool `task_exec` döndürür. İkisi de tam kimlikle denetlenir. Aynı katalog hash'i ve başarılı fixture kaydı olmadan gerçek Codex görevi başlamaz. Aynı hesapla gerçek inference de geçti; başka model/sürüme genellenmez. Tüm extension yolları ve profil dağıtımı hâlâ ürün kabulüdür.

## Kod / diff doğrulayıcısı

Kontrollü görev `/task/sum.mjs` içindeki `sumIntegers` hatasını düzeltir. Task namespace'i export boyunca pause edilir; ayrı network-none exporter readonly volume'den yalnız tek regular dosyayı alır. Symlink, extra file, hardlink, NUL, geçersiz UTF-8 ve 16 KiB üstü içerik reddedilir. Bu tek dosya smoke'u genel Git repository/arşiv importer veya production artifact scanner değildir.

Aday yeni bir verifier namespace'inde readonly bağlanır. Beklenen sonuçlar host'taki bağımsız oracle'da kalır; 12 sınır/invalid case ve export sonrası üretilen 20 örnek sonuçla karşılaştırılır. Candidate exit code 0 tek başına yeterli değildir. Aday hash'i tekrar kontrol edilir. Host, aday kodu çalıştırmaz; bounded metinden `git diff --no-index --no-ext-diff --no-textconv` üretip ayrı baseline dizininde `git apply --check` yapar. Doğrulama programı, adayın düzenleyebildiği task dosyalarında bulunmaz.

## Kanıt ve bulgular

- İki CLI cache'iyle 8'er sınır kontrolü (16 toplam) geçti: mount/network kısıtları, rakip komutun incumbent'ı silememesi, task auth/env/proxy reddi, destination reddi, public TLS, broker authorization/attempt, 16 çağrı sonrasında execution reddi ve private home restart. Canary testinde gerçek credential okunmadı.
- Kod doğrulayıcısı 8 kontrol geçti: bozuk baseline, exit-0 spoof, frozen snapshot, 32 örnek, geçerli patch, extra file, tek başına symlink ve oversized dosya. Aday deterministik fixture'dır; AI üretimi değildir.
- Claude 2.1.293 / `claude-sonnet-4-6` ile Claude.ai managed oturumunda gerçek kodlama geçti: 7 task çağrısı, fresh readonly verifier'da 32 örnek ve geçerli patch. Codex 0.157.1 / `gpt-6-astra` dar profilinde ChatGPT managed oturumuyla aynı görev geçti: 2 task çağrısı, 32 örnek ve geçerli patch. Tek kontrollü görev genel kod doğruluğu veya production izolasyonu ispatı değildir.
- Codex resmi `account/read {refreshToken:true}` başarılı döndü ve hesap authenticated kaldı. Token byte'ları okunmadı; rotation içeriği ölçülmedi. Her iki izole profile resmi logout uygulandı; authenticated false ve namespace cleanup doğrulandı. Yeni CLI namespace'inde tekrar resmi status da oturumsuz döndü. Native Windows oturumlarına logout uygulanmadı.
- `npm run check`: 66 Node testi (8 script + 58 package), Go testleri, generated/types ve frontend/Go build geçti. Değişmeyen PostgreSQL/Temporal/UI/native testleri tekrarlanmadı.
- İlk Codex device login TLS/network hatası verdi. Pinned Node slim imajında `/etc/ssl/certs` yoktu; Node bundled roots handshake testi bunu göstermiyordu. Aynı pinned imajın public roots listesi readonly `ca.pem` olarak kuruldu; `CODEX_CA_CERTIFICATE` / `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` ile TLS açık kaldı. Her start içerik eşitliği doğrulanır. Ardından kullanıcı iki yeni resmi girişi tamamladı; host auth dosyaları taşınmadı. Öncesinde Claude managed-task oturum önkoşulunda sıfır model çağrısıyla durdu.
- Kaspersky HTTPS incelemesi Claude model isteğinin sertifika zincirini değiştirdi. Windows `SslStream` hostname/chain doğrulaması ve installed Root kontrolünden sonra yalnız public root Claude'a özel CA ekine alındı. Private key, host auth veya tüm Windows trust store kopyalanmadı; TLS kapatılmadı. Yerel certificate/proof yayımlanmaz. `export-windows-trust.ps1` bu dar kontrolü tekrarlar; farklı mevcut root üzerine yazmaz. Antivirus/ağ trust değişikliği yeniden inceleme gerektirir; genel CA rotation desteği değildir.
- Codex CLI asset/refresh akışında gözlenen `files.openai.com`, `sdmntprcentralus.oaiusercontent.com`, `sdmntprsouthcentralus.oaiusercontent.com` exact allowlist'e eklendi; wildcard açılmadı. Auth/model hostları ve Claude hedefleri `egress-policy.ts` içindedir. Başka bölgeler/CDN değişiklikleri ayrıca sınanmalıdır.
- Host/Docker kesintisinde sonuçsuz kalan bir görev başarısız olarak kaydedildi; restart sonrasında yalnız sahipliği doğrulanmış, durmuş iki namespace ve task hacmi temizlendi. Private profile hacimleri korundu. Elle uzlaştırma production crash recovery değildir.

Sanitize edilmiş raporlar ve gerçek AI patch'leri [test kayıtlarında](../results/README.md). Coding raporları verifier ve cleanup sonucunu içerir; session raporu da cleanup doğrulanmadan başarı yazmaz. E-posta/account ID/token/ham provider yanıtları tutulmaz. Private auth hacmi yayımlanan paketin girdisi değildir.

Kaynaklar ve koşullar 2026-10-08'de okundu: [OpenAI managed auth](https://learn.chatgpt.com/docs/auth), [app-server auth](https://learn.chatgpt.com/docs/app-server), [0.157.1 device-code source](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/login/src/device_code_auth.rs), [Claude authentication](https://code.claude.com/docs/en/authentication), [Claude network configuration](https://code.claude.com/docs/en/network-config), [Claude embedding koşulları](https://code.claude.com/docs/en/legal-and-compliance). Claude metni değiştirilmemiş binary'nin son kullanıcı tarafından kendi hesabıyla kullanılmasına ilişkin embedding yolunu ayırır; kendi subscription-token proxy'si veya kullanım yeniden satışı bu tasarımın yolu değildir. Dağıtım/lisans ve ürün kabulü ayrıca değerlendirilir.

## Kalan kabul

Claude doğal expiry/refresh/relogin, kota/eşzamanlı kullanım, tüm hook/plugin/subagent/model yolları, gerçek credential'ı ifşa etmeyen kapsamlı saldırı kontrolleri, genel artifact importer/secret scanner, imaj güven zinciri, otomatik crash recovery/private cache retention ve diğer hostlar. Ürün dağıtım/provider koşulları ayrıca kabul edilir. CLI restart canary token renewal kanıtı değildir. Desktop/API execution `false`, izolasyon kararı `not_evaluated`, F1 GO kapısı ve tamamlanmış v1 kapsamı korunur.

Yeni profil/ağ kaynakları: [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference), [pinned tool plan](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/core/src/tools/spec_plan.rs), [pinned model catalog](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/models-manager/models.json), [OpenAI network önerileri](https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps).
