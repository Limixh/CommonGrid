# Faz 0: CLI / sandbox fizibilitesi

Durum: **NOT EVALUATED**. İki resmi CLI ile izole gerçek kodlama, bağımsız verifier/diff, Codex managed refresh ve iki profile logout geçti. Claude doğal yenilemesi ve geniş adversarial/platform kabulü tamamlanmadı; GO kararı yoktur.

## Açık kaynak kabul denemeleri

- `temporal/`: bağımsız, fixture-only Go modülü; SDK testleri ve gerçek SQLite development server üzerinde worker/server kesintisi, checkpoint replay, retry, deadline ve iptal. Çalıştırma: `npm run test:spike`, `npm run install:temporal`, `npm run spike:recovery`. Bu deneme CLI izolasyonunu veya production HA'yı doğrulamaz.
- `cli-routing/`: sabit Codex sürümü/SWE-ReX commit'i ve kaynak hash'leriyle araç yönlendirme araştırması. `npm run spike:routing` yalnız version/help/engine bilgisi okur; hesap/kimlik bilgisi okumaz, model çağırmaz. Canlı runtime/kimlik testleri bekliyor.
- `sandbox/`: kurulum sonrası gerçek Docker Linux/WSL2 task-tools sınırında 12 saldırı/yaşam döngüsü kontrolü ve owned cleanup geçti. Sahte auth fixture; resmi CLI/MCP/gerçek hesap ve bütün izolasyon kapısı henüz doğrulanmadı. `npm run spike:sandbox`.
- `cli-session/`: değiştirilmemiş Claude 2.1.293 ve Codex 0.157.1 Linux ikilileriyle ayrı CLI/task namespace'lerinde 20 protokol/araç/sahte kimlik kontrolü geçti. MCP / dynamic tool aynı broker'a gider; model yanıtları yerel fixture'dır. Ayrı `spike:account-smoke`, native Windows Claude.ai Pro/ChatGPT oturumuyla araçsız gerçek yanıtı doğruladı; OS kimlik izolasyonu veya gerçek görev/diff değildir.
- Private managed-session/cache ve stdio provider egress adayı: önceki 16 canary/ağ/budget/restart/concurrent-command kontrolü ve gerçek Claude/Codex adaylarının 32'şer verifier örneği ADR 0006'da kayıtlıdır. Codex dar araç profili ayrıca 10 fixture kontrolü geçti; resmi refresh isteği ve iki izole logout doğrulandı. Sonraki saldırı/control/lifecycle/artifact güçlendirmesi ADR 0007'de, tekrar komutları `cli-session/MANAGED_SESSIONS.md` içindedir.
- `npm run spike:managed-adversarial`: yeni sentetik profillerde her sağlayıcı için görev dosya/process/fd/env/socket/ptrace erişimi, PID/tmpfs tükenmesi, proxy/broker sınırları ve namespace teardown. Gerçek hesap/model çağrısı veya eski private profile erişimi yoktur. `npm run spike:coding-verifier`: tek dosyalı adayın güvenli export'u, bağımsız oracle ve gerçekten uygulanmış patch hash'i. Genel importer/secret scanner kabulü değildir.
- Bileşen tercihleri spec §7.5/§14 ve `docs/OPEN_SOURCE_SELECTION.md` içinde; sonuçlar `docs/DEVELOPMENT.md` ve ADR'lerde tutulur.

| Bileşen | Windows x64 | macOS | Linux |
|---|---|---|---|
| Codex CLI sürüm kontrolü | 0.157.1 native + Docker Linux fixture | Test edilmedi | Host CI tanımlı, çalıştırılmadı |
| Claude Code | Native 2.1.293 + Docker Linux fixture | Test edilmedi | Host CI tanımlı, çalıştırılmadı |
| Docker / Podman | Docker 29.8.2 / Desktop 4.94.0; Linux/WSL2 engine erişilebilir, Podman yok | Test edilmedi | Test edilmedi |
| Task-tools fixture sınırı | 12/12 kontrol ve temizlik geçti | Test edilmedi | CI tanımlı, çalıştırılmadı |
| Resmi CLI/task yönlendirmesi, sahte auth | Docker Linux namespace'lerinde 20/20 ve cleanup | Test edilmedi | Host CI tanımlı, çalıştırılmadı |
| Gerçek abonelik bağlantısı, araçsız metin | Claude.ai Pro ve ChatGPT geçti | Test edilmedi | Test edilmedi |
| CLI/auth ayrımı | Private managed home; 16 önceki sınır kontrolü ve yeni sentetik adversarial paket; kapsam ADR 0007 | Kanıt yok | Kanıt yok |
| Gerçek diff + temiz doğrulama | Claude Sonnet 4.6 + Codex `gpt-6-astra` dar profil; 32'şer örnek ve patch geçti | Çalıştırılmadı | Çalıştırılmadı |
| Yenileme / logout / kota | Codex resmi refresh isteği ve iki izole logout geçti; Claude expiry/kota/eşzamanlılık bekliyor | Çalıştırılmadı | Çalıştırılmadı |

`npm run doctor` yalnız binary sürümü ve varsa konteyner motorunun erişilebilirliğini ölçer. Kimlik dosyası okumaz; giriş durumunu veya izolasyonu doğrulamış saymaz. Rapor `.local/doctor.json` dosyasına yazılır ve geliştirme arayüzü tarafından okunur. Bu dosya Git'e girmez.

`describeTaskContainer` görev araç ortamının dar izinli tanımını üretir. İç `TaskToolsRuntime` yalnız sandbox ve CLI fixture başlatıcılarında uygulanır; UI/API'ye bağlı değildir. Invocation tanımı süreç başlatmaz. Görev seçip CLI'ı host'ta çalıştıran ürün yolu yoktur. Parser unit testleri yapay olaylar kullanır; CLI fixture testinde gerçek CLI completion ayrıca task roundtrip/dosya/sınır kontrolleriyle doğrulanır. Native subscription smoke sabit güvenilir metin kullanır, görev yürütmez.

Gerekli kanıtlar, her CLI ve desteklenen platform için ayrı kaydedilecek:

1. Resmi binary değiştirilmeden kullanıcının resmi oturumuyla model çağrısı, dosya değişimi ve geçerli diff.
2. Araç işlemlerinin görev ortamı dışına çıkamaması; CLI dosya aracından da auth, SSH, tarayıcı ve host dosyalarına erişememesi.
3. Görev kodunun `/proc`, ortam, açık dosya tanıtıcısı, ptrace/bellek ve konteyner soketinden kimlik verisi okuyamaması.
4. Token yenileme, logout, eşzamanlı kullanım, kota, süre ve iptal senaryoları.
5. Sağlayıcı uç noktalarına CLI erişimi; görev süreçlerinde ağın kapalı olması; platforma gönderilen artifact/log içeriklerinde kimlik verisi bulunmaması.
6. İki ajan için sağlayıcı koşullarının sürüm/tarih bazlı kaydı.

Kontrollü gerçek hesap denemeleri bu kimlik ayrımıyla geçti; kapsam her raporda ayrıca belirtilir. Tam inceleme sonucu GO / GO WITH LIMITATION / REWORK / NO-GO olarak yol haritasındaki kurallarla kaydedilecek. Bağımsız Faz 0 temelleri geliştirilebilir.
