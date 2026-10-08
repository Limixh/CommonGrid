# ADR 0008 — Oturum sürekliliği, kota ve işlem sahipliği

Tarih: 2026-10-08. Durum: **F0 referans uygulaması ve sentetik yerel kabul tamamlandı; GO verilmedi.** Referans ortam Windows x64 host ve Docker Linux/WSL2'dir. ADR 0006/0007'deki tarihli gerçek hesap kanıtları bu değişikliklerle tekrar kabul edilmiş sayılmaz.

## Karar

Kullanıcı ticari ürün hedefini ve **katılımcının kendi aboneliğiyle resmi CLI çalıştırma** tasarımını koruyarak geliştirmeye devam etmeyi seçti. API/yerel model yönüne geçiş yapılmaz. Sağlayıcı uyumluluğu incelemesi [ayrı kayıt](../../docs/PROVIDER_COMPATIBILITY.md) olarak kalır; bu geliştirme kararı sağlayıcı kabulü veya production GO değildir. Tamamlanmış v1.0 kapsamı korunur.

Bir profile ait auth/tools hacimleri kalıcı olabilir; her runtime işlemi ayrı UUID ile sahiplenilir. Konteyner sahibi, işlem UUID'si, immutable Docker ID ve çalışır/durmuş durumu birlikte doğrulanır. Komut ve kontrol köprüsü doğrulanmış ID'ye gönderilir. Eski işlem temizliği yeni işlemin konteynerini silemez. Timeout/iptalde yalnız Docker istemcisini kapatmak yeterli olmadığından gönderilmiş ID'nin namespace'i kaldırılır; özel hacimler tutulur.

`recoverStopped(expectedOperation)` sadece sahibi ve beklenen işlem kimliği doğrulanan durmuş konteyneri uzlaştırır. Silme zorlamasızdır; konteyner tekrar çalışmaya başlarsa Docker silmeyi reddeder. Canlı işlem devralma, otomatik crash detection, production profile lock veya kalıcı operation journal uygulanmış sayılmaz. Açık `destroy` komutu tüm seçili profile ait kaynakları kaldırma sözleşmesini korur.

Resmi oturum yardımcıları import sırasında login, Docker veya CLI başlatmaz. CLI komutları ayrı entry point'tir. Kabul runner'ı kullanıcı tarafından açık `--real-account` seçimi gerektirir; model çağrısı veya logout yapmaz. Status → namespace restart → status sırasını, Codex için resmi refresh isteği → status → salt okunur kota okumasını denetler. Deadline ve iptal kalıcıdır; cleanup ayrı sınırlı zaman bütçesiyle çalışır. Bekleyen bir işlem varken temizliğin kesinleştiği veya kabulün geçtiği raporlanmaz.

Checkpoint yalnız profile/provider bağlanmış zaman damgaları ve başarılı koşu sayısını tutar; bilinmeyen alanlar reddedilir. Token, kullanıcı adı, e-posta veya credential içeriği taşımaz. Resume aralığı ve iki authenticated status doğal expiry/renewal kanıtı değildir; `renewal_observed=false` kalır. Codex refresh isteğinin başarılı olması token byte rotation ölçümü sayılmaz.

Start/stop ve ownership denetimleri AbortSignal taşır. Create istemcisi returned ID gelmeden iptal/timeout olursa daemon'un sonradan oluşturma ihtimali runtime'da belirsiz kalır; bir `ls` yokluk görüntüsü cleanup kanıtı sayılmaz. Aynı owner/operation'a ait immutable ID gözlenip kaldırılmadan belirsizlik çözülmez. Sonraki host/daemon uzlaştırması ve kalıcı journal hâlâ ayrı iştir.

Codex `account/rateLimits/read` yalnız resmi bildirilen sayısal pencereleri korur. Hesap kimlikleri, bucket adları, kredi ve ham payload atılır. `available` burada **kota bilgisi alınabildi** demektir; kalan kullanımın yeterli olduğunu söylemez. Desteklenmeyen metot veya bildirilmeyen pencere `unknown` olur. Claude için doğrulanmış yapılandırılmış kota/force-refresh metodu iddia edilmez. Tükenme/reset davranışı ve gerçek hesaptaki paralel kullanım ayrı kabul işidir; ücretli API fallback yoktur.

## Tekrar

```powershell
npm run check
npm run spike:session-continuity
npm run spike:managed-adversarial
```

Süreklilik runner'ı iki sağlayıcı için yeni sentetik profile hazırlar; eski private profillere erişmez, resmi login veya model çağrısı yapmaz. Altı contender start reddi, yanlış işlem exec/bridge reddi, canlı recovery reddi, sahte state'in restart'ta korunması, durmuş tam işlem uzlaştırması, eski cleanup'ın successor'ı koruması, timeout/AbortSignal sonrası detached child'ın geç yazamaması, kesilen control ve sessiz readiness kontrol edilir. Sonunda yalnız bu koşunun yeni kaynakları kaldırılır. Tek sağlayıcı için `-- claude` veya `-- codex` seçilebilir.

Salt okunur hesap kabul komutu CI'a bağlı değildir:

```powershell
npm run spike:session-acceptance -- codex CODEX_UUID --real-account
npm run spike:session-acceptance -- codex CODEX_UUID --real-account --resume
```

Claude için aynı komut provider olarak `claude` alır. Hazır profile manifesti ve resmi giriş gereklidir; runner kendiliğinden login veya cache/auth aktarımı başlatmaz. Bu aşamada gerçek hesap kabul komutu çalıştırılmadı. Ubuntu CI'a yalnız sentetik süreklilik runner'ı ve genel pure fixture testleri eklendi; uzak CI yerel kanıtla geçmiş sayılmaz.

## Yerel kabul

Son koşuların tarihli public kayıtları `spike/results` altında yayımlanır. Başarısız/ara koşular ve loglar `.local` altında korunur. Genel artifact importer/scanner, diğer hostlar, Claude doğal expiry/renewal, gerçek kota ve eşzamanlı abonelik kullanımı kapanmış sayılmaz.

**Claude 9 + Codex 9 Docker süreklilik grubu** ve cleanup geçti. Sağlayıcı başına altı contender start reddi dahil bütün referans senaryolar başarılıdır. `managed-continuity-windows-2026-10-08.json` yeni sentetik profile kanıtıdır; resmi auth/CLI model çalışması değildir. Genel kontrol **167 Node testi (13 + 154)**, generated/typecheck, Go testleri ve frontend/Go build ile geçti; `session-foundations-windows-2026-10-08.json` son kayıttır. Yeni runtime regression kapsamı 17, provider/acceptance saf fixture kapsamı 29 testtir. Uzak CI ve PostgreSQL/Temporal/UI/native release bu değişiklikte tekrar çalıştırılmadı.

Final runtime kaynaklarıyla adversarial paket **Claude 11 + Codex 11 grup** olarak tekrar geçti; public `managed-adversarial-windows-2026-10-08.json` yenilendi. Owner etiketli test konteyneri kalmadı; yalnız önceki iki oturumsuz profile ait dört auth/tools hacmi korundu. Önceki private profile içeriğine erişilmedi.

`execution_enabled=false`, `isolation_gate=not_evaluated` ve F1 öncesi GO/GO WITH LIMITATION kapısı korunur.
