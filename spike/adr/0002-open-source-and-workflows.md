# ADR 0002 — Açık kaynak bileşenler ve kalıcı sunucu iş akışları

Tarih: 2026-10-08 · Durum: Tercihler kabul edildi; Temporal F0 denemesi geçti, production/staging ve CLI izolasyon kapıları bekliyor.

## Karar

Tamamlanmış v1 kapsamı korunur. Go koordinatör, Rust/Tauri masaüstü ve React arayüzü devam eder. Sunucu workflow altyapısında Temporal tercih edilir. Kullanıcı cihazları Temporal worker'ı olmaz; doğrulanmış olaylar koordinatör üzerinden teslim edilir. PostgreSQL domain kaydı yetkilidir; atomik rezervasyon/kabul/puan işlemleri ve transaction outbox üretim entegrasyonunda ayrıca uygulanır.

Cosign + Trivy imaj zincirinde F1–F2, OpenTelemetry F1, Monaco/xterm.js çalışma ekranında F1–F3 ve React Flow arama ağacında F5 planına alındı. OPA, git2-rs, gVisor/Kata ve Semgrep kendi teknik/lisans kabul koşullarıyla değerlendirilir. Redis cache/rate limit adayıdır. Argo ve doğrudan Firecracker yönetimi ertelenir; BOINC ve SWE-agent referanstır.

## Windows x64 F0 kanıtı

- Ayrı `spike/temporal` Go modülü; SDK 1.49.0 ve CLI 1.9.1 / development server 1.32.0. CLI arşivi resmi release checksum'ıyla doğrulandı.
- Altı SDK testi geçti: checkpoint/tekrar/eski olay, deadline, waiting iptali, production input reddi, kalıcı Activity hata ve çift result.
- Gerçek worker ve SQLite development server süreçleri checkpoint sonrası zorla kapatıldı. Aynı persistence ile yeni süreçlerden durum/history geri kazanıldı. Eski hash reddedildi; Activity yan etkisi sonrası enjekte edilen hata retry ile toparlandı ve bir fixture marker'ı kaldı. Deadline ve iptal gerçek sunucuda geçti.
- Kod/şema/API kontrolleri, 49 Node testi ve frontend/Go build geçti. Spike için Go vet ve yeni Node script syntax kontrolleri geçti.
- Linux/macOS için aynı fixture testleri CI'a eklendi; uzaktan çalıştırılmadı, doğrulanmış platform sayılmaz.

Kayıtlar: `spike/results/temporal-windows-2026-10-08.json`, `spike/results/cli-routing-windows-2026-10-08.json`. Ham SQLite ve süreç logları `.local` altında, sürüm kontrolü dışındadır.

## CLI / SWE-ReX bulgusu

Codex 0.157.1 version/help algılandı; sabit sürüm ve SWE-ReX commit'i için altı kaynak hash'i doğrulandı. Codex shell gate'i ve patch kaydı ayrıdır; yalnız shell'i kapatan/MCP ekleyen tasarım henüz tüm dosya yollarının task ortamına yönlendiğini kanıtlamaz. Kaldırılmış `apply_patch_freeform` flag'i çözüm olarak kullanılmaz. Claude'un belgelenmiş araç seçimi yerelde test edilmedi. Docker/Podman ve Claude bu makinede bulunmadı; SWE-ReX kurulmadı veya çalıştırılmadı.

Bu araştırma **NOT EVALUATED** kimlik kapısını değiştirmez. Gerçek hesap/model çağrısı yapılmadı. Önce ayrı OS kimlikleri, task/control ağ sınırı ve tüm native dosya/komut yolları sahte canary'lerle test edilir. Başka desteklenen CLI ortam entegrasyonlarının imkânsız olduğu sonucu çıkarılmaz.

## Production için kalan kabul

1. PostgreSQL outbox/deduplication, atomik bütçe ve winner/puan transaction'ları; Job yan etkilerinin tekrar teslim/worker ölümüyle uzlaştırılması.
2. Temporal staging deployment; retention/history sınırı, deterministik sürüm yükseltme/replay, yedek/geri yükleme, throughput ve maliyet. F0 SQLite testi production HA değildir.
3. Gerçek artifact/checkpoint depolama ve temiz sandbox restore; imza/tarama raporunun gerçek imaj digest'ine bağlanması.
4. CLI/platform kimlik, token yenileme, sağlayıcı uyumluluk kapısı; üç platform testleri.

Fixture dosya ledger'ı production idempotency mekanizması değildir. Temporal retry'si gönüllünün CLI'ını yeniden başlatamaz. Bu tercih takvim kazancını henüz ölçmez.
