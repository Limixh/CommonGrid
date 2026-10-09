# ADR 0013 — Güncel ucuz model kabulü

Tarih: 2026-10-09 (yerel; kayıtların UTC zamanı 8 Ekim 21:xx). Durum: Haiku görevi kabul edildi; Luna görev adayı/verifier kabulü başarısız. GO verilmedi; `execution_enabled=false`, `isolation_gate=not_evaluated`.

## Kabul kapsamı

Kullanıcı kendi hesabıyla resmi CLI girişini yeni izole Claude/Codex profillerinde tamamlar. Mevcut host credential dosyaları okunmaz veya kopyalanmaz. Sonraki gözlemlerde aynı profile korunur; gerekli olmadıkça login/logout yapılmaz. Güncel resmi CLI sürümü, binary hash'i, kaynak commit'i ve varsa dar katalog/profil hash'i kanıta bağlanır. İşlev testi yalnız Codex `gpt-6-luna` ve Claude `haiku` kullanır.

İstenen model ve resmi yanıtın bildirdiği model ID'si ayrı kaydedilir ve ucuz seçimin uygulandığı doğrulanır. Haiku alias'ı ile resolved ID aynı string varsayılmaz. Sağlayıcı bildirmiyorsa observed ID `unknown` kalır; istenen değer observed kanıt diye sunulmaz. Model bulunamazsa veya seçim doğrulanamazsa kabul durur. Pahalı/varsayılan modele ve ücretli API'ye geçilmez.

Her sağlayıcı için sabit kontrollü görev bir kez çalıştırılır. Başarı; gerçek dosya değişimi, patch byte hash'i, uygulanmış aday ile verifier adayının hash eşitliği, bağımsız verifier ve CLI/task cleanup ile birlikte kaydedilir. Provider completion tek başına kabul değildir. Model retry ve kota tükenmesi denemesi yapılmaz. Hata önce mevcut fixture ile değerlendirilir; gerçek kota/reset davranışı normal kullanımda gözlenir.

Salt okunur resmi status, restart ve Codex quota/refresh gözlemleri ayrı kanıttır. Checkpoint ilk/son kabul gözlemini ve başarılı koşu sayısını taşır; login/expiry zamanı değildir. Resume süresi, iki authenticated status veya Codex refresh isteği doğal yenileme kanıtı sayılmaz. Kota snapshot'ı bilgi erişimidir; kullanım izni ya da tükenme/reset kanıtı değildir. Claude doğal provider yenilemesi, gerçek kota ve eşzamanlılık bekler.

Credential ve token/expiry içeriği ajan veya kabul kodu tarafından okunmaz; auth yalnız resmi CLI tarafından yönetilir. Kanıtta credential, device code, ham kimlik/sağlayıcı logu veya makineye özel CA yayımlanmaz. Profile owner metadata yerel eşleştirmede tutulur; public kayda yalnız teknik olarak gerekli bilgi alınır. Genel altyapı eklenmez; tam v1 hedefi ve [ADR 0012](0012-go-gate-priority-and-development-boundaries.md) sınırları korunur. Komutlar [oturum prosedüründe](../cli-session/MANAGED_SESSIONS.md), açık kapılar [GO listesinde](../../docs/GO_GATE.md) durur.

## Güncel yerel sonuç

[Güncel kabul kaydı](../results/current-cli-acceptance-windows-2026-10-09.json) kaynak/CLI/hash bağlamını ve ayrı koşuların sonucunu tutar. Her sağlayıcı için bir gerçek model görevi çalıştırıldı; inference retry yapılmadı.

- [Haiku](../results/managed-task-haiku-windows-2026-10-09.json): istenen `haiku`, gözlenen `claude-haiku-5-5` doğrulandı. Üç broker denemesi; 32 verifier örneği, gerçekten uygulanmış [patch](../results/managed-task-haiku-2026-10-09.patch), uygulanan aday/verifier hash eşitliği ve cleanup geçti. Patch byte hash'i ayrıca doğrulandı. Bundled roots kullanıldı; optional host CA yoktu.
- [Luna](../results/managed-task-luna-windows-2026-10-09.json): istenen/gözlenen `gpt-6-luna` doğrulandı. Altı doğrulanmış callback denemesi başarılı komut kanıtı değildir. Aday baseline ile aynı kaldı; 32 örnekli verifier genel sonucu başarısız, görev `success=false` / `managed_validation_failed`, cleanup=true. Kök neden bilinmiyor; completion veya model doğrulaması görev başarısı sayılmadı.
- Claude resmi status/restart/status ve checkpoint geçti; doğal yenileme kanıtı üretmedi. Codex aynı başlangıç aşamalarını geçti, resmi refresh 30 saniyelik deadline ile başarısız oldu ve cleanup geçti. Sonraki gerçek Luna task'ında resmi refresh döndü; ilk başarısız sonuç korunur.
- Ayrı resmi salt okunur Codex quota okuması başarıyla normalleştirildi. Değerler private kalır; snapshot kota tükenmesi/reset, kullanım izni veya token yenilemesi kanıtı değildir.

[Luna dar profil fixture](../results/codex-luna-profile-windows-2026-10-09.json) ve [yerel genel kontrol](../results/cheap-model-foundations-windows-2026-10-09.json) ayrı kanıttır; fixture gerçek model görevindeki başarısızlığı kapatmaz. Önceki Docker login/fixture cleanup=false kayıtları değiştirilmedi. Exact ID ve sahiplik kontrollü manuel uzlaştırma orphan kaynaklarını temizledi; auth/tools hacimleri tutuldu.

Gerçek görevler `b2c28b1` kaynağıyla çalıştı. Sonraki `c46bd84` düzeltmesinde yalnız Codex callback sonuç kategorisi, çıkış kodu ve stdout/stderr byte sayısı kaydedilir; argv, ham çıktı veya provider payload'ı saklanmaz. İki sağlayıcıda `candidate_changed` ve sabit provider completion durumu eklenir. Verifier reddi sabit `managed_candidate_rejected` olur; çıktı limiti aşılınca callback `success=false` döner. Geçmiş Luna kaydının `managed_validation_failed` alanı korunur. [Son genel kontrol](../results/cheap-model-foundations-windows-2026-10-09.json) 284 testi, tip kontrollerini ve derlemeleri geçti; bu düzeltmeden sonra gerçek model tekrar çalıştırılmadı.

Model denetimi resmi olarak bilinen Haiku 4.5 tarihli/alias kimliklerini ve `claude-haiku-5-5` kimliğini açık listeyle kabul eder; daha sonra farklı model bildirilirse durur. Liste için [resmi CLI model yapılandırması](https://code.claude.com/docs/en/model-config) ve [Haiku 5.5 geçiş belgesi](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide) kullanıldı. Bu tercih ürün kullanıcısının normal görev modelini sınırlandırmaz.

Yeni iki profile sonraki normal gözlemler için giriş yapmış halde korundu; önceki Sonnet/Astra profilleri logout durumundadır. Sonraki normal Luna görevinde yeni tanı alanlarıyla araç sonuçları değerlendirilir. Bu turda ek model çağrısı yapılmadı. Claude doğal yenilemesi, gerçek kota/reset/eşzamanlılık ve geniş platform/tool kabulü bekler. GO verilmedi; tam v1 kapsamı korunur.

## Ayrı CI kanıtı

Resmi GitHub Foundations run `37840191064`, commit `7a91deafdd3707cec0fc6e4a380d5b37fd1d0799` için 11 başarılı job'ın kaydı [github-foundations-7a91dea-2026-10-08.json](../results/github-foundations-7a91dea-2026-10-08.json) içinde:

| Job | Kabul kapsamı |
|---|---|
| `cli-session-fixtures` | Linux resmi CLI protokol fixture, sentetik saldırı ve süreklilik |
| `sandbox-fixtures` | Linux task-tools ve coding verifier fixture |
| `postgres-domain` | Linux PostgreSQL domain kabulü |
| `contracts-api-ui` | Linux genel check ve Playwright UI |
| `artifact-delivery` | Linux Trivy ve artifact teslimi kabulü |
| `desktop-compile` × 3 | Linux/Windows/macOS native `--no-bundle` compile |
| `temporal-fixtures` × 3 | Linux/Windows/macOS Temporal fixture ve recovery |

Bu CI yalnız `7a91dea` commit'ini kapsar; sonraki yerel tanı/model doğrulama kodu için CI kabulü değildir. Native compile paketlenmiş auth, dağıtım/signing veya son kullanıcı kurulum kabulü değildir. CI gerçek hesap/model çıkarımı, doğal provider yenilemesi veya kota kabulü sağlamaz. Yerel gerçek sonuçlar yukarıda ayrı tarihli kanıtlarla kaydedildi; eski pahalı model raporları değiştirilmez. Bu ADR GO kararı üretmez.
