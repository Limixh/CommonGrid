# Temporal F0 denemesi

Bu ayrı Go modülü production API'ye bağlı değildir. Yalnız `Fixture: true` girişleri kabul eder. Ajan başlatmaz, bütçe harcamaz, gerçek artifact doğrulamaz veya puan vermez. Domain kiralama/inceleme durumlarının yerine geçmez.

Sabit sürümler: Temporal Go SDK **1.49.0**, CLI **1.9.1** (paketlediği development server **1.32.0**). Go bağımlılıkları `go.sum`, CLI arşivi `scripts/install-temporal.mjs` içindeki resmi release SHA-256 değerleriyle sabitlenmiştir. Kurulum proje içindeki `.tools` altına yapılır; global PATH değişmez.

```powershell
npm run test:spike
npm run install:temporal
npm run spike:recovery
```

`test:spike` Temporal SDK test ortamında sanal zamanla checkpoint/tekrar olay, eski lease/hash, süre dolması, iptal, production girişinin reddi ve Activity hata davranışını sınar.

`spike:recovery` gerçek development server'ı rastgele loopback portunda, SQLite persistence ile başlatır. Ayrı worker süreçtir. Checkpoint işlendiği query ile görüldükten sonra **bu denemenin** worker ve server süreçleri zorla kapatılır. Aynı veritabanıyla yeniden başlatılan worker checkpoint'i history'den geri kazanır; eski hash olayı reddedilir. Fixture doğrulayıcısı yan etkiyi kaydettikten sonra kasıtlı hata verir; retry aynı idempotency anahtarını kullanır ve yalnız bir fixture kaydı kalır. Ayrı akışlarda deadline ve iptal de gerçek sunucuda kontrol edilir.

Her çalıştırma `.local/temporal-recovery/run-*/` altında ayrı SQLite, worker/server logları ve `report.json` üretir. Başarılı/başarısız süreçler kapanırken temizlenir; mevcut koordinatör veya kullanıcı servisleri durdurulmaz. Go module/build/temp cache'leri `.tools` altındadır. Development server Docker gerektirmez.

## Kanıtın sınırı

- Workflow query durumu production domain kaydı değildir; API yalnız PostgreSQL'i yetkili kaynak olarak kullanacaktır.
- Fixture dosya kaydı PostgreSQL transaction outbox'ı, dağıtık uniqueness, Kubernetes Job uzlaştırması veya exactly-once kanıtı değildir. Kısmi dosya yazımı ve çoklu worker/process yarışları production ledger tasarımıyla çözülecektir.
- Bu test Activity retry'si için sabit kimliğin gerektiğini gösterir. Kullanıcı CLI'ı yeniden başlatma yolu yoktur.
- Checkpoint yalnız opaque fixture kimliğidir; gerçek nesne depolama veya sandbox restore yapılmaz.
- SQLite development server production HA, yedek/geri yükleme, throughput, retention/history büyüklüğü veya hosting maliyetini doğrulamaz. Bunlar staging kapısında kalır.
- CLI/auth izolasyonu değerlendirilmiş sayılmaz.

Kaynaklar: [Temporal Go test suite](https://docs.temporal.io/develop/go/testing-suite), [development server](https://docs.temporal.io/develop/run-a-development-server), [SDK sürümü](https://github.com/temporalio/sdk-go/releases/tag/v1.49.0), [CLI sürümü ve checksum'lar](https://github.com/temporalio/cli/releases/tag/v1.9.1).
