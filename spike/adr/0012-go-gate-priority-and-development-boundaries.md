# ADR 0012 — GO kapısı önceliği ve geliştirme sınırları

Tarih: 2026-10-08. Durum: F0 kabul planı; GO verilmedi. `execution_enabled=false`, `isolation_gate=not_evaluated`.

## Karar

Tam v1 kapsamı korunur. Yeni genel altyapı katmanlarından önce güncel resmi CLI auth/görev kabulü, Claude doğal yenilemesi, normal kullanımda kota/eşzamanlılık gözlemi ve taşınabilir izolasyon kanıtı tamamlanır. Kabulü destekleyen küçük güvenlik düzeltmeleri yapılabilir; geniş altyapı önceliği teknik kabulün arkasına alınır. Ayrıntılı kalan işler [GO listesinde](../../docs/GO_GATE.md), tam ürün hedefi [spec](../../PROJECT_SPEC1.2.md) ve [yol haritasında](../../implementation_roadmap1.3.md) durur.

Gerçek işlev testleri Codex `gpt-6-luna`, Claude `haiku` kullanır. Ucuz model kullanılamıyorsa test durur; pahalı modele, hesap varsayılanına veya ücretli API'ye geçilmez. Kota kasıtlı tüketilmez. Limit/hata/deadline/cleanup önce yerel fixture ile sınanır; gerçek limit/reset davranışı normal kullanımda gözlenir. Salt okunur quota snapshot, Codex refresh isteği veya resume checkpoint doğal yenileme ve kota tükenmesi kanıtı sayılmaz.

TLS için pinned imajın bundled roots listesi varsayılandır. Host CA keşfi otomatik yapılmaz. Ek Claude root, PEM ve proof açıkça seçilerek tek profile owner ve hash'lere bağlanır. Startup yalnız sabit tools hacmindeki seçim ve sertifika süresini doğrular; host dosyasını tekrar okumaz. Değişen root yeni açık profile seçimi gerektirir. Güncel komutlar [MANAGED_SESSIONS.md](../cli-session/MANAGED_SESSIONS.md) içindedir; tarihli Kaspersky bulgusu genel host gereksinimi değildir.

## Kod, test ve kayıt sınırı

İlk checkpoint commit mevcut doğrulanmış geliştirme temelini korur. Sonraki değişiklikler anlamlı checkpoint commit'lerle kaydedilir; geçmiş kanıtın sonuç/model alanları değiştirilmez. Commit alınması veya fixture başarısı GO kararı üretmez.

Saf quota normalizasyonu ve session protokol yardımcıları `packages/agent-adapters` altında kalır. İşlev testi model politikası ayrı `testing/functional-test-models` yolundadır; ürün varsayılanı değildir. Managed runtime, gerçek hesap komutları ve deneysel kabul runner'ları `spike/` içinde tutulur. Paket çıkarımı bu runner'ların production'a kabul edildiği anlamına gelmez.

`npm run test:product` ürün/saf paket testlerini, `npm run test:spike-fixtures` sentetik CLI güvenlik ve protokol testlerini çalıştırır. `npm run check` her iki grubu korur. Gerçek hesap/model ve Docker kabul komutları ayrı kalır. Güncel README kısa giriş ve mevcut durumu gösterir; eski uygulama notları [geliştirme arşivinde](../../docs/DEVELOPMENT_HISTORY.md), ölçüm ve kapsamlar [tarihli rapor indeksinde](../results/README.md) tutulur.

## Kanıt ve açık kapılar

Önceki gerçek görevler ve artifact/verifier kabulü tarihli kanıttır. Güncel kaynakla [genel kontrol](../results/go-gate-foundations-windows-2026-10-08.json), [sentetik süreklilik](../results/go-gate-continuity-windows-2026-10-08.json) ve [saldırı paketi](../results/go-gate-adversarial-windows-2026-10-08.json) geçti; Docker kaynak temizliği doğrulandı. Bu tur gerçek hesap, model çıkarımı ve doğal provider yenilemesi kabulü vermez.

Güncel Luna/Haiku gerçek görev kabulü, Claude doğal yenilemesi, normal kota/reset/eşzamanlılık gözlemi, provider/tool yolları ve diğer hostlar bekler. Karar her sağlayıcı, model, CLI sürümü ve host kapsamında kanıta göre ayrıca verilir. Bu ADR GO / GO WITH LIMITATION kararı değildir; desktop/API görev çalıştırma kapalı kalır.
