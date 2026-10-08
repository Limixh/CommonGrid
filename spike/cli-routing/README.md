# Resmi CLI / SWE-ReX yönlendirme araştırması

Durum: **Kaynak ve sürüm incelemesi; canlı izolasyon kapısı NOT EVALUATED.**

```powershell
npm run spike:routing
```

Komut yalnız CLI version/help ve Docker/Podman engine bilgisi kontrolü yapar. `sources.lock.json` ile sabitlenen açık kaynak dosyalarını indirip SHA-256 doğrular; kaynakları çalıştırmaz. Model çağrısı, hesap sorgusu, auth dosyası okuma, CLI ayarı değiştirme veya sandbox görevi başlatma yapmaz. Rapor ve kaynak cache'i `.local/cli-routing` altındadır.

## 2026-10-08 kaynak bulguları

- **Codex 0.157.1:** `features.shell_tool` varsayılan shell yolunu kapatabilir. Ancak sabit sürümün `spec_plan.rs` dosyasında `apply_patch` kaydı ayrı bir koşula (`environment` ve model araç desteği) bağlıdır. `features.apply_patch_freeform` ise kaldırılmış bir uyumluluk flag'idir; dosya düzenlemeyi kapatan güvenilir bir anahtar olarak kullanılamaz. Bu kaynak bulgusu shell-off + MCP yaklaşımının tüm yerel dosya yollarını yönlendirdiğini kanıtlamadığını gösterir; başka desteklenen ortam entegrasyonlarının imkânsız olduğu iddiası değildir.
- **Claude Code:** Resmi belgelerde `--tools ""` built-in araçları kapatmak, `--strict-mcp-config` MCP kaynaklarını seçmek için mekanizmalardır. `--allowedTools` otomatik izin listesi olarak yorumlanmalı, tek başına araç kapatma/OS izolasyonu sayılmamalıdır. Native Windows **2.1.293** version/help doğrulandı. CLI fixture denemesinde strict MCP ve built-in-off birlikte yalnız CommonGrid task aracını sundu; bu read-only probe bunu ölçmez. `--bare` OAuth/keychain okumadığı için abonelik oturumu için seçilmez.
- **Codex app-server adayı:** Sabit kaynak `thread/start.environments: []` için environment erişiminin kapandığını belgeler; experimental handshake ve dynamic `task_exec` ile seçili fixture profilinde canlı roundtrip geçti. Model preset/code mode araçları `additional_tools` içinde de gelebilir; yalnız top-level `tools` listesi veya tek feature flag'i yeterli değildir. Yeni Rust thread kaynağıyla lock **7** dosya içerir. Ayrıntılar `../cli-session/README.md` ve ADR 0005'te.
- **SWE-ReX:** `5c995c365dfb1fd5bc56fda688be5d8538f9931f` commit'i incelendi. Python >=3.10 bağımlılığı vardır. Docker deployment runtime API portu yayınlar ve ek Docker argümanları alır. Network-off görev kodu ile dar kontrol kanalının nasıl birlikte sağlanacağı, task'ın API/daemon'a erişememesi ve kimliklerin ayrı OS sınırında kalması CommonGrid tasarımının işidir.

## Canlı deneme sözleşmesi

1. Önce sahte kimlik/canary dosyalarıyla ayrı CLI/auth, görev ve runtime-control kimlikleri; kişisel host dosyaları denemeye girdi olmaz.
2. Native shell, patch, read/image, MCP, eklenti ve alt ajan araç yolları tek tek envanterlenir. Yeni CLI sürümü kapıyı yeniden açar.
3. Araç dosya işlemleri yalnız task workspace'ine ulaşır; traversal, symlink, mutlak host yol, `/proc`/env/fd/ptrace, socket, API token ve daemon saldırıları reddedilir. API'nin loopback olması aynı namespace'teki task için tek başına engel değildir.
4. Timeout/iptal child process ağacını durdurur; artifact paketleme yalnız task workspace'inden yapılır. Ağ/süre/kaynak sınırları runtime'da uygulanır.
5. Bu sınır geçtikten sonra resmi hesapla gerçek diff, token yenileme/logout ve sağlayıcı koşulları sınanır. Yalnız kaynak/protokol incelemesi GO kararı üretmez.

Tam matris ve kapı `spike/README.md` ve yol haritası §3.1–3.2'de korunur. SWE-ReX henüz desktop bağımlılığı veya production runtime değildir.

Docker kurulumundan sonra `spike:sandbox` 12 kontrol; `spike:cli-session` iki resmi CLI için 20 kontrol ve cleanup geçti. Ayrı native Windows subscription smoke gerçek araçsız yanıtı doğruladı. Bu kanıtlar sandbox gerçek hesap/diff, auth yenileme veya tam GO sayılmaz. Kapsam `../sandbox/README.md` ve `../cli-session/README.md` içinde. Windows'ta native Claude `.local/bin` konumu process PATH eski olsa da read-only probe tarafından algılanır; shell shim'e yalnız kapalı version/help argv listesi geçebilir.

Kaynaklar: [OpenAI Docs — configuration reference](https://developers.openai.com/codex/config-reference), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [SWE-ReX sabit commit](https://github.com/SWE-agent/SWE-ReX/tree/5c995c365dfb1fd5bc56fda688be5d8538f9931f). Codex kaynak provenance'ı ve her dosyanın hash'i `sources.lock.json` içindedir.
