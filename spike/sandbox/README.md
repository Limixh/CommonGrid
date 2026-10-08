# Canlı görev sandbox denemesi

2026-10-08 · Windows x64, Docker Desktop Linux/WSL2 motoru: **12/12 fixture kontrolü geçti; owned kaynak temizliği doğrulandı.** Tüm CLI/auth fizibilite kapısı hâlâ **NOT EVALUATED**; bu sonuç GO kararı üretmez.

```powershell
npm run doctor
npm run spike:routing
npm run spike:sandbox
```

`spike:sandbox` Linux konteyner motoru gerektirir. İlk çalıştırmada `image.lock.json` ile digest'i sabitlenmiş resmi Node 22 imajını indirir. Başka bir image, kişisel dizin, kimlik dosyası veya Docker socket bağlamaz. Her çalıştırma yeni isimli volume ve sahiplik etiketli konteynerler oluşturur. Temizlik yalnız bu denemenin isimleri ve doğrulanmış etiketleriyle yapılır; genel prune yoktur. İmaj yerel cache'te kalır.

## Sınır ve çalışma biçimi

`packages/agent-adapters/src/task-runtime.ts` sadece F0 fixture başlatıcısının kullandığı iç modüldür. HTTP/masaüstü görev başlatma yolu bağlı değildir. Görev kodu `docker exec` üzerinden doğrudan argv ile gönderilir; host shell komutu olarak çalıştırılmaz. Komut çıktısı, süre ve iptal sınırlıdır. Timeout, iptal veya çıktı taşması görev konteynerini kaldırır; böylece alt süreçler aynı PID namespace'iyle sonlanır. Başlatma hatası da sahip olunan kaynakların temizliğini dener; engine erişilemezse başarı varsayılmaz ve temizlik doğrulanamadı olarak hata döner.

Görev ortamı non-root UID 65532, salt okunur root filesystem, yalnız opaque `/task` volume'ü, `network=none`, tüm capabilities kapalı, `no-new-privileges`, varsayılan seccomp, özel PID namespace ve Docker init ile çalışır. CPU 1, bellek/swap 256 MiB, PID 128; `/tmp` 64 MiB tmpfs ve `noexec,nosuid` olur. Kaynak üst sınırları cgroup dosyalarından da kontrol edilir. Yeni volume yalnız güvenilen tek seferlik `chown` konteyneriyle hazırlanır; bu konteynerde sadece `CHOWN` capability vardır.

Sahte CLI/auth fixture'ı ayrı konteyner/PID namespace ve özel `/auth` tmpfs kullanır. Gerçek resmi CLI, abonelik veya OAuth oturumu değildir. Rastgele canary yalnız bu fixture'a ve `.local` içindeki sahte host dosyasına yazılır. Denemede kişisel auth/SSH/tarayıcı dosyaları okunmaz. Ana rapor canary içeriği veya ham ortam/log verisi içermez.

## Geçen kontroller

1. Runtime kullanıcı, mount, ağ, capability, seccomp ve kaynak politikası.
2. `/task` yazımı; root filesystem yazımının reddi.
3. Kernel cgroup bellek, PID ve CPU sınırları.
4. Mutlak host yolu, traversal, symlink, auth canary ve daemon socket erişiminin başarısız olması.
5. Ortam ve `/proc` üzerinden ayrı sahte kimliğin görülememesi.
6. Dış IP'ye TCP bağlantısının başarısız olması.
7. `/tmp` dosyasının doğrudan çalıştırılması ve mount namespace oluşturmanın reddi.
8. Alt süreç üretiminin PID cgroup sınırına ulaşınca reddi.
9. Yeni attempt volume'ünde önceki dosyanın bulunmaması.
10. Timeout'un önceden başlatıldığı ve yaşadığı doğrulanan detached alt süreç içeren görev ortamını kapatması.
11. İptalin aynı şekilde canlı detached alt süreç içeren tüm görev ortamını kapatması.
12. Aşırı çıktının iletilmeden görev ortamını kapatması.

Ek olarak bütün owned konteyner/volume'lerin kaldırıldığı ve engine'in hâlâ erişilebilir olduğu doğrulanır. `/tmp noexec` kontrolü interpreter ile dosya okunmasını engellediği iddiası değildir; görev kodu zaten bu sınır içinde çalışabilir. Ağ denemesi temel network-off davranışını ölçer; tüm olası kaçışların kanıtı değildir.

## Bulgu → değişiklik

İlk canlı denemede boş workspace volume'ünün sahipliği sonraki konteynerde yeniden root oldu; non-root görev yazımı başarısızdı. Docker'ın volume copy-up davranışını kapatmak için hem initialization hem task mount'una `volume-nocopy` eklendi. Tekrar çalıştırılan yazma/temizlik ve diğer kontroller geçti. İlk başarısız ham kayıt `.local/sandbox` içinde tutulur; başarı raporu onun yerine geçirilmez.

## Kalan kabul kriterleri

- Resmi Claude/Codex CLI/auth OS sınırı; built-in file/command/image, MCP, plugin, hook ve alt ajan yollarının canlı envanteri.
- MCP/control kanalının kimlik doğrulaması; task'ın broker/daemon/API token'a erişememesi; yarış koşullu path ve artifact paketleme saldırıları.
- Resmi hesapla diff + bağımsız doğrulama, token yenileme/logout/kota ve sağlayıcı uyumluluğu.
- Broker veya Docker/host kesintisinden sonra deadline ve cleanup uzlaştırması. Fixture PID1 timer'ı production crash recovery garantisi sayılmaz.
- Windows host testi dışında macOS/Linux host matrisi ve bağımsız güvenlik incelemesi. Ubuntu fixture CI işi eklendi; uzak CI burada çalıştırılmadı.

Raporlar `.local/sandbox/<run-id>/report.json` altında; son başarılı kanıt `spike/results/sandbox-windows-2026-10-08.json` içinde. Genel agent execution kapalı kalır.

Kaynaklar: [Docker volume copy-up / volume-nocopy](https://docs.docker.com/engine/storage/volumes/), [kaynak sınırları](https://docs.docker.com/engine/containers/resource_constraints/), [Docker güvenlik modeli](https://docs.docker.com/engine/security/).
