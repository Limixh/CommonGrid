# ADR 0005 — İki resmi CLI için dar görev aracı yönlendirmesi

2026-10-08 · **F0 fixture uygulanıp geçti; gerçek abonelik bağlantısı ayrı smoke kanıtı. GO kararı değil.**

## Karar ve gerekçe

Claude için built-in araçları kapalı strict MCP; Codex için app-server experimental empty environment ve dynamic tool yolu F0 referans adaylarıdır. İki protokol aynı attempt'e bağlı `executeTaskTool` üzerinden ayrı task-tools runtime'a gider. Görev input'u Docker executable/container/cwd/env seçemez. Kişisel kimlik, host dosyaları ve Docker soketi task'a veya fixture CLI'a bağlanmaz.

Codex'te yalnız shell flag'i yeterli değildir. Sabit 0.157.1 kaynak `thread/start.environments` boş dizisini environment erişimini kapatan seçenek olarak tanımlar; seçili model/profilin gerçek wire request'inde dosya/komut araçlarının yokluğu ayrıca sınandı. Experimental API, model preset ve CLI sürümü destek matrisi için ayrı bağımlılıklardır. `gpt-6-sol` denemesi code-mode `additional_tools` taşımasını gösterdi; envanter bu alanı da içerir. Başarılı fixture `gpt-5.1-codex` profilinde yalnız `task_exec` sunar. Bir profilin sonucu diğerine genellenmez.

Trusted CLI namespace'indeki stdio MCP / app-server callback kanalı loopback kontrol sunucusuna ulaşır; model ve MCP fixture token'ı CLI sınırında kalır. Task namespace'inde ağ kapalıdır. Auth canary/CLI env ve control endpoint'ine task koduyla erişim reddedildi; yanlış control token ve attempt seçimi ayrıca reddedildi. Bu, bütün adversarial araç ve auth yollarının kanıtı değildir.

## Kanıt

- Resmi binary arşiv/ikili hash'leri `cli-session/binaries.lock.json`; Claude signed manifest ve signer pin'i proje keyring'inde doğrulanır. Codex ilgili Rust kaynak hash'i routing lock'a eklendi (7/7).
- `npm run spike:cli-session`: Claude 2.1.293 ve Codex 0.157.1 için 10'ar kontrol, toplam 20/20 ve owner etiketine bağlı cleanup geçti. Model yanıtları yerel SSE fixture; gerçek hesap kullanılmadı.
- `npm run spike:account-smoke`: native Windows'ta Claude.ai Pro ve ChatGPT mevcut resmi oturumuyla sabit, araçsız metin yanıtı geçti. Auth dosyası kopyalanmadı; API key fallback yapılmadı. Native host bağlantısı CLI OS izolasyonu veya sandbox görev/diff kanıtı değildir.
- Task sandbox saldırı paketi runtime launcher değişikliğinden sonra 12/12 tekrar geçti. Process tree timeout, binary stdin byte bütünlüğü/output bound, provider parser ve kapalı task-tool input testleri eklendi.
- Windows Buildx inherited-pipe timeout, read-only Docker cp ve noexec tmpfs bulguları başlatıcı/init tasarımına işlendi. Başarısız ham kayıtlar `.local` içinde korunur; yalnız owner doğrulanan kaynaklar temizlenir. Broad prune yapılmaz.

Raporlar `../results/cli-session-windows-2026-10-08.json`, `../results/account-smoke-windows-2026-10-08.json` ve `../results/sandbox-windows-2026-10-08.json`; tekrar komutları `../cli-session/README.md` içinde.

## Kabul için kalan işler

Mevcut native abonelik oturumunu OS ile ayrılmış resmi CLI/auth runtime'da desteklenen giriş mekanizmasıyla kullanma, gerçek görev/diff ve bağımsız doğrulama, token yenileme/logout/eşzamanlı kota, provider network allowlist, task artifact yarışları ve paketleme, crash/recovery, diğer model profilleri/tüm araç yolları ve üç host platformu. Sağlayıcı otomasyon/dağıtım koşulları sürüm/tarih bazında kaydedilecek. SWE-ReX henüz production runtime olarak kabul edilmez; bu deneme yalnız CommonGrid dar broker adayını sınar.

Desktop/HTTP execution kapısı `false`, izolasyon kararı `not_evaluated` kalır. F1 başlangıcı için yol haritasındaki GO/GO WITH LIMITATION kriterleri değiştirilmedi; tamamlanmış v1 kapsamı korunur.
