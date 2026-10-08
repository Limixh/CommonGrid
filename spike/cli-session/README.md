# Resmi CLI / görev aracı denemesi

2026-10-08 · **Claude 2.1.293 ve Codex 0.157.1: 20/20 kontrol ve owned cleanup geçti.** Windows host, Docker Linux/WSL2, x86_64. Tam fizibilite kapısı `NOT EVALUATED`; desktop/API görev çalıştırma kapalıdır.

Sonraki denemelerde private resmi auth hacmi, readonly CLI cache'i, stdio provider egress ve ayrı coding verifier uygulandı. Önceki 16 boundary kontrolü, iki resmi izole login ve iki gerçek AI adayının 32'şer verifier örneği/diff'i geçti; Codex resmi refresh isteği ve iki izole logout kaydedildi. Güncel sentetik saldırı, broker/relay/lifecycle ve artifact güçlendirmesi [ADR 0007](../adr/0007-adversarial-control-artifact-and-lifecycle.md) kapsamındadır. Claude doğal expiry/refresh ve tam fizibilite kabulü bekler. Komutlar [MANAGED_SESSIONS.md](MANAGED_SESSIONS.md), önceki gerçek hesap kanıtı [ADR 0006](../adr/0006-managed-cli-sessions-and-coding-verifier.md) içinde.

## Tekrar çalıştırma

Linux konteyner motoru ve `spike/sandbox/image.lock.json` içindeki sabit Node imajı gerekir. Önce `npm run spike:sandbox`, ardından:

```powershell
npm run install:cli-fixtures
npm run spike:cli-session
```

Kurulum yalnız `.tools/cli-fixtures` altına resmi Linux ikililerini indirir. Codex release arşivi ve çıkarılan ikili SHA-256 ile; Claude ikilisi SHA-256 ve resmi manifest GPG imzası/sabit primary signer fingerprint'iyle doğrulanır. Windows'ta Git'in GPG/GPGV araçları, Linux'ta `tar`, `gpg`, `gpgv` kullanılır. Kullanıcı keyring'i, global kurulum ve CLI hesap dosyaları denemenin girdisi değildir. TLS kontrolü kapatılmaz. Sürüm veya model profili değişirse bu deneme yeniden geçmelidir.

## Sınır ve protokol

Her sağlayıcı için ayrı CLI konteyneri (UID 1000, network-off, read-only rootfs, CPU 1, RAM 1 GiB) ve görev konteyneri (UID 65532, CPU 1, RAM 256 MiB) oluşturulur. Host bind mount'u veya Docker soketi yoktur. Doğrulanmış **public** ikili ve trusted fixture kaynakları başlangıçta stdin üzerinden CLI'a özel tmpfs'e aktarılır; root init yalnız bu disposable dosyaları yazar. CLI/model/mock kimliği ile görev araçları farklı filesystem/PID/network namespace'lerinde kalır. Kontrol sunucusu yalnız CLI namespace'inin loopback adresinde bulunur; host portu yayınlanmaz.

- **Claude:** built-in araçlar `--tools ""` ile kapalı; `--restricted`, boş setting sources, strict tek MCP kaynağı, slash commands/session persistence/browser entegrasyonu kapalı. MCP yalnız `mcp__commongrid__task_exec` sunar.
- **Codex:** değiştirilmemiş app-server binary; experimental handshake, `thread/start.environments: []`, tek dynamic `task_exec`. Code mode, goals, tool search, multi-agent/v2, apps ve async kullanıcı araçları için dar fixture konfigürasyonu. `tools.experimental_request_user_input.enabled=false` nesne alanı olarak uygulanır. Fixture model profili `gpt-5.1-codex`; bütün model profillerine genellenmez.
- İki yol aynı `executeTaskTool` broker'ına ulaşır. Kapalı argv/timeout şeması başka container, cwd, host env veya attempt seçimine izin vermez. Task argv host shell'den geçmez. Task araçları kendi namespace'lerinde filesystem kullanabilir; bu namespace'e gerçek auth bağlanmaz.
- Gerçek CLI'ın **model isteğinde** araç envanteri doğrulanır; Responses `input.additional_tools` alanı da taranır. Beklenmeyen araç fixture'ı reddeder. Completion event'i tek başına başarı sayılmaz: araç çağrısı, oluşturulan görev dosyası ve sınır kontrolleri ayrıca zorunludur.

Model yanıtları CLI namespace'indeki deterministik Anthropic/Responses SSE fixture'ıdır. Gerçek CLI protokolü ve araç akışı çalışır; model çıkarımı/abonelik/token tüketimi bu testte **yoktur**. CLI ortamındaki API key sadece sahte fixture string'idir. Fixture usage değerleri maliyet veya token ölçümü değildir.

Her CLI için sürüm, wire request, native dosya/komut araçlarının yokluğu, tek başarılı task roundtrip, workspace yazma, sahte auth/env erişim reddi, control-channel erişim reddi, canary değişmemesi, yanlış token için 401 ve başka attempt seçiminin reddi sınanır. Sonuçlar `.local/cli-session/<run-id>/report.json`; yayımlanan son kayıt `../results/cli-session-windows-2026-10-08.json`.

## Gerçek abonelik bağlantısı: ayrı kanıt

```powershell
npm run spike:account-smoke
```

Bu **Windows'a özel, açıkça başlatılan yerel** geliştirici denemesidir; CI'da çalışmaz. Native resmi CLI'lar mevcut oturumlarını kendileri kullanır: Claude.ai Pro ve ChatGPT. Yeni boş bir çalışma dizininde yalnız sabit `CG_OK` yanıtı istenir; görev/repository metni verilmez. Claude'da araçlar/MCP kapalı, Codex'te environments/dynamicTools boş ve araç/approval callback'leri reddedilir. API key/provider yönlendirme env seçenekleri temizlenir; ücretli API fallback uygulanmaz. Codex modeli resmi `model/list` yanıtından seçilir; global tercih değiştirilmez.

İki gerçek bağlantı geçti. Rapor e-posta, account ID, auth içeriği, ham sağlayıcı logu veya tam yanıt saklamaz. Bu test **native host süreci** kullanır; CLI'ın kendi OS kimlik izolasyonu, sandbox içinde gerçek görev/diff veya token yenileme/logout kanıtı değildir. Rapor: `../results/account-smoke-windows-2026-10-08.json`.

## Test bulguları ve ölçüm sınırı

- Windows'ta Buildx child'ı Docker parent öldürüldükten sonra output pipe'larını açık tuttu. Trusted launcher artık sahip olduğu process tree/group'u kapatır ve deadline'da hemen reddeder. Inherited stdout tutan gerçek child ile regression testi geçti.
- Docker `cp` read-only rootfs'te tmpfs hedefini de reddetti; public ikililer trusted stdin stream ile aktarılıyor. Yalnız ikili tmpfs'inde `exec` açık; task tmpfs noexec kalır. Her CLI binary'sini tmpfs'e kopyalamak üretim dağıtım tercihi değildir.
- Sonraki tekrarda araç kontrolleri geçti fakat cleanup teyidi başarısızdı; daha sonra resource kalmadığı ayrıca görüldü. Başlatıcı owned kaynakların yokluğunu bounded yeniden sorgular; timeout'tan sonra delete'in başarılı olduğunu varsaymaz. Sahiplik uyuşmazlığında silmez. İlk belirsiz cleanup raporu başarısız olarak korunur.
- `gpt-6-sol` fixture profilinde code mode araçları `additional_tools` içinde geldi; top-level `tools` envanteri yeterli değildi. Kapalı envanter her iki alanı kapsar. Mevcut fixture profili başarıyla daraltıldı; yeni model/profil aynı kapıdan geçmeden desteklenmiş sayılmaz.
- Native Codex bağlantısında kayıtlı modele bağlı kalan deneme başarısızdı; model/list seçimiyle geçti. İlk hatanın mesajı tutulmadığından bunun kesin kök nedeni çıkarılmaz.

Host Windows 11 Home Single Language, yaklaşık 12 GiB RAM; Docker WSL2 Linux kernel `6.6.87.2`, engine belleği yaklaşık 5.7 GiB. Base Debian Bookworm Slim + Node 22 imajı `326104305` byte (~311 MiB). CLI ikilileri ek olarak Claude ~241 MiB, Codex ~272 MiB'dır. Rapordaki CLI setup süreleri public ikili aktarımını; cgroup memory peak bu tmpfs ikilisi, cache ve fixture süreçlerini de içerir. Task startup, local fixture turn ve memory ölçümleri bir warm-image yerel gözlemdir; gerçek inference gecikmesi, production kapasitesi veya karşılaştırmalı OS benchmark'ı değildir.

Son başarılı tekrarın tek örneği (CLI hazırlığı tekrar binary kopyalar; bu yük üretim için optimize edilmelidir):

| CLI | Task startup | CLI hazırlığı | Yerel fixture turn | CLI cgroup peak | Task cgroup peak |
|---|---:|---:|---:|---:|---:|
| Claude 2.1.293 | 4.79 s | 111.69 s | 3.82 s | 379.2 MiB | 15.9 MiB |
| Codex 0.157.1 | 3.28 s | 97.59 s | 2.94 s | 324.1 MiB | 15.6 MiB |

Sonraki [managed oturum hattında](MANAGED_SESSIONS.md) iki gerçek görev/diff, fresh verifier'da 32'şer örnek, Codex managed refresh ve iki izole logout geçti. `gpt-6-astra` public katalog profili ayrıca 10 wire fixture kontrolüyle yalnız `functions.task_exec` sunacak şekilde doğrulandı. İlk 20 kontrolün eski fixture profiliyle olan kaydı ayrı korunur. Tam plugin/hook/subagent yolları, Claude doğal yenilemesi/kota, genel artifact güvenliği, crash recovery, ürün koşulları ve macOS/Linux host kabulü hâlâ gereklidir. Ubuntu CLI fixture CI işi tanımlıdır; uzak CI çalıştırılmadı.

Resmi kaynaklar: [OpenAI app-server](https://learn.chatgpt.com/docs/app-server), [Codex 0.157.1 thread protokolü](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/app-server-protocol/src/protocol/v2/thread.rs), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [Claude setup ve binary doğrulama](https://code.claude.com/docs/en/setup). Sabit kaynak/ikili hash'leri ile canlı test sonucu birlikte değerlendirilir.
