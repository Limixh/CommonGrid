# PROJECT_SPEC.md

> **Çalışma adı:** _(belirlenecek)_
> **Sürüm:** 1.2 — Revize bitmiş ürün spesifikasyonu (kimlik izolasyonu, doğrulanmış ayrıştırma, katkı bütçesi ve görev sözleşmeleri netleştirildi)
> **Durum:** Taslak

---

## 1. Genel Bakış

### 1.1 Problem
Yapay zekâ şirketleri zor problemleri (matematik, yazılım) çok sayıda ajanı paralel çalıştırarak, yani devasa compute ile çözüyor. Bireysel kullanıcıların elinde ise abonelik limitleri var ve bu limitlerin önemli kısmı her dönem kullanılmadan sıfırlanıyor.

### 1.2 Çözüm
Gönüllülerin kendi yapay zekâ ajanlarını (Claude Code, Codex CLI vb.) ortak problemlerin alt görevlerinde çalıştırdığı, dağıtık bir topluluk platformu. Büyük bir problem küçük, bağımsız görevlere bölünür; gönüllüler görev seçer, ajanları izole bir ortamda çalışır, sonuçlar sunucu tarafında otomatik olarak doğrulanır. Bir **orkestratör** sonuçlara bakarak yeni görevler açar, umut veren dallara daha fazla compute ayırır, farklı ajanları dener ve sonuç vermeyen dalları kapatır; yani platform statik bir iş listesi değil, sürekli yönlendirilen bir arama süreci yürütür.

Dağıtık katılımın çözüm oranını veya çözüm süresini iyileştirmesi bir ürün hipotezidir. Benzer modellerin hataları ilişkili olabilir; katılımcı sayısının artması tek başına başarı garantisi sayılmaz. Fayda, eşit bütçeli gerçek görev karşılaştırmalarıyla geliştirme boyunca ölçülür (§10.8).

### 1.3 Temel İlkeler
1. **Güvenme, doğrula:** Gönüllüden gelen hiçbir sonuca güvenilmez. Her sonuç sunucuda bağımsız olarak doğrulanır.
2. **Kimlik bilgisine dokunma:** Uygulama hiçbir yapay zekâ hesabının giriş bilgisini, token'ını veya API anahtarını kendi sunucularına göndermez ve saklamaz. Kullanıcı resmi CLI araçlarına kendisi giriş yapar (bkz. §6.3).
3. **Kullanıcı kontrolü:** Her görev kullanıcının açık onayıyla başlar (elle seçim veya sunulan görev atamasını onaylama).
4. **İzolasyon:** Güvenilmeyen görev kodu ve ajan araç işlemleri her zaman sandbox içinde çalışır; kullanıcının kişisel kaynaklarına ve kimlik bilgilerine erişemez. Resmi CLI/auth çalışma zamanı ayrı bir güven sınırıdır (§6.3).
5. **Şeffaflık:** Her katkı, kimin hangi görevi çözdüğüyle birlikte kamuya açık olarak kaydedilir.
6. **Emek kaybolmaz:** Tamamlanamayan çalışmalar checkpoint olarak saklanır ve başka bir katkıcı kaldığı yerden devam edebilir (bkz. §6.6).

---

## 2. Kapsam

### 2.1 v1.0 Kapsamında
Hedef, MVP'nin ötesinde tamamlanmış bir v1.0 ürünüdür. Aşağıdaki kapsam geliştirme boyunca korunur; ara sürümler, teknik denemeler ve alfa/beta aşamaları bu ürüne ulaşmak için doğrulama adımlarıdır. Test sonuçları mimariyi, uygulama sırasını ve takvimi güncelleyebilir. Kapsam değişirse gerekçesi ve yeni kabul kriterleri bu belgeye ve uygulama yol haritasına birlikte işlenir.

Uygulama durumu ve kabul kanıtları [geliştirme rehberinde](docs/DEVELOPMENT.md) ve [GO listesinde](docs/GO_GATE.md) izlenir. Bu belge bitmiş v1 ürününün gereksinimlerini tanımlar.

- Windows, macOS ve Linux masaüstü uygulaması
- Bulut ajan desteği: Claude Code, Codex CLI
- İki proje türü: **Matematik (Lean 4)** ve **Yazılım (test tabanlı)**
- Otomatik sandbox kurulumu
- Merkezi koordinatör ve doğrulama altyapısı
- Dinamik orkestratör (görev üretimi, compute dağıtımı, ajan seçimi, dal kapatma)
- Doğrulanmış sonuçlar için inceleme ve birleştirme akışı
- Proje sahibi paneli (proje ve görev oluşturma)
- Moderasyon sistemi
- Puan, itibar, liderlik tablosu ve katkı geçmişi
- Web sitesi (projeleri ve sonuçları herkese açık gösteren)
- Türkçe ve İngilizce arayüz
- Yerel katkı bütçesi, kullanım sınırları ve ücretli kullanıma geçiş kontrolü (§6.9)

### 2.2 v1.0 Kapsamı Dışında
- Yerel model desteği (Ollama, llama.cpp vb.) → bkz. §17 Yol Haritası
- Mobil uygulama
- Ücretli görevler / ödül havuzu

---

## 3. Kullanıcı Rolleri

| Rol | Açıklama | Yetkiler |
|---|---|---|
| **Gönüllü** | Ajanını görevlerde çalıştıran kullanıcı | Görev seçme, çalıştırma, sonuç gönderme, profil |
| **Proje Sahibi** | Problem getiren kişi veya kurum | Proje oluşturma, görev tanımlama, doğrulama komutu belirleme |
| **Moderatör** | Güvenilir topluluk üyesi | Görev onaylama/reddetme, şüpheli sonuçları inceleme, kullanıcı raporları |
| **Yönetici** | Platform ekibi | Tüm yetkiler, sistem ayarları |

---

## 4. Temel Kavramlar

- **Proje:** Çözülmek istenen büyük problem (örn. "X teoreminin ispatı", "Y kütüphanesinin Rust'a taşınması").
- **Görev:** Projenin ayrı bir deneme olarak çalıştırılabilen parçası. Türüne göre ispat, diff veya yapılandırılmış plan üretir; sunucuda çalışan, sürümlenmiş bir doğrulama sözleşmesiyle kontrol edilir (§8.6).
- **Kiralama (Lease):** Bir görevin belirli bir süre boyunca bir gönüllüye ayrılması.
- **Deneme:** Bir gönüllünün bir görev üzerindeki tek çalıştırması.
- **Sonuç:** Denemenin çıktısı (Lean dosyası veya kod diff'i).
- **Doğrulama:** Sonucun sunucuda otomatik kontrolü.
- **Arama Ağacı:** Projenin hedef yapısı. Her düğüm bir alt hedeftir; düğümler ya **ayrıştırma** (tüm alt hedefler çözülmeli — AND) ya da **alternatif yaklaşım** (biri yeterli — OR) ilişkisiyle bağlanır. Görev bağımlılıkları (DAG) bu ağaçtan türetilir.
- **Dal:** Bir düğüm ve altındaki tüm düğümler; genellikle tek bir çözüm yaklaşımını temsil eder.
- **Bütçe:** Bir projeye veya dala ayrılan zamanlama kapasitesi (birim: **ajan-saati**); gerçek model tüketiminin kanıtı değildir. Kullanıcının yerel katkı sınırları ve platformun parasal altyapı bütçesi ayrı tutulur (§6.9, §10.5, §15).
- **Orkestratör:** Doğrulanmış sinyallere bakarak görev açan, compute dağıtan, ajan öneren ve dal kapatan sunucu bileşeni (§10).
- **Milestone:** Bir görev içinde proje sahibinin tanımladığı, sunucuda ölçülen ve ağırlığı olan ara hedef (§11.2).
- **Aday Sonuç (verified_candidate):** Otomatik doğrulamayı geçmiş ama henüz birleştirilmemiş sonuç (§9.6).

---

## 5. Sistem Mimarisi

```
┌────────────────────────────┐        ┌───────────────────────────┐
│   Masaüstü Uygulaması       │  HTTPS │      Koordinatör           │
│  ┌──────────┐ ┌──────────┐  │◄──────►│  API · Kiralama            │
│  │ Arayüz   │ │ Ajan     │  │  WSS   │  Kiralama · Puanlama       │
│  │ (Web UI) │ │ Adaptörü │  │        │  Moderasyon · Orkestratör  │
│  └──────────┘ └────┬─────┘  │        └─────────┬─────────────────┘
│       CLI/auth güven sınırı │                  │
│              ┌────▼──────┐ │        ┌─────────▼─────────────────┐
│              │ Görev     │ │        │ Temporal · Sunucu Worker  │
│              │ sandbox'ı │ │        └─────────┬─────────────────┘
│              └───────────┘ │        ┌─────────▼─────────────────┐
│                            │        │ Doğrulayıcı · K8s Job     │
│                            │        └───────────────────────────┘
└────────────────────────────┘
                                        ┌───────────────────────────┐
                                        │ Postgres · S3 · Önbellek   │
                                        └───────────────────────────┘
```

Temporal sunucu iş akışlarını yönetir; kullanıcı cihazları Temporal worker'ı değildir. CLI/auth ile görev araçları ayrı güven sınırlarında kalır (§6.3). Temporal'ın kendi persistence kaydı, koordinatörün domain veritabanından ayrıdır (§7.5).

---

## 6. Masaüstü Uygulaması

### 6.1 Platformlar
- Windows 10/11 (x64, ARM64)
- macOS 13+ (Apple Silicon, Intel)
- Linux (Ubuntu 22.04+, Fedora 39+; AppImage ve .deb/.rpm)

### 6.2 Ajan Adaptörleri
Her ajan ortak bir arayüzü uygular:

```
interface AgentAdapter {
  id: string                       // "claude-code", "codex-cli"
  detect(): InstallStatus          // kurulu mu, sürüm, giriş yapılmış mı
  prepare(sandbox, task): void     // ajanı sandbox'a bağla
  run(prompt, limits): RunHandle   // başlat
  stream(): LogEvent[]             // canlı çıktı
  stop(): void
  collect(): ResultArtifact        // çıktıyı topla
}
```

**v1.0 adaptörleri:**
| Ajan | Çalıştırma | Notlar |
|---|---|---|
| Claude Code | `claude -p` (headless) | Kullanıcının kendi oturumu |
| Codex CLI | `codex exec` | Kullanıcının kendi oturumu |

Adaptör sistemi eklenti yapısındadır; yeni ajanlar uygulama güncellemesi gerekmeden eklenebilir.

Her denemede sağlayıcı, CLI/adaptör sürümü, model kimliği ve varsa model sürümü, reasoning ayarı, strateji kimliği ve görev sözleşmesi hash'i kaydedilir. CLI'ın bildirmediği değerler `unknown` olarak tutulur; farklı profiller tek bir ajan başarı oranında birleştirilmez. İstemciden gelen profil ve kullanım bilgileri kaynaklarıyla işaretlenir, sunucunun doğruladığı sonuçla karıştırılmaz. CLI çıktısının yanında resmi entegrasyon protokolleri de teknik denemede değerlendirilir; seçilen entegrasyon sağlayıcı kurallarına uymalıdır.

### 6.3 Kimlik Bilgisi ve Ajan Oturumu İlkesi
- Uygulama, desteklenen yapay zekâ CLI araçlarının kimlik doğrulama bilgilerini, token'larını, API anahtarlarını veya oturum verilerini kendi sunucularına **hiçbir zaman göndermez**.
- Kullanıcı Claude Code, Codex CLI veya desteklenen diğer resmi araçlara kendi cihazında, aracın resmi giriş yöntemiyle giriş yapar.
- Uygulama kimlik bilgilerinin içeriğini mümkün olduğunca doğrudan okumaz veya parse etmez; yalnızca ilgili CLI'ın kullanılabilir ve giriş yapılmış durumda olup olmadığını CLI'ın kendi durum komutuyla tespit eder.
- Ajanın model servisine erişimi, mümkün olduğunda host sistem üzerinde çalışan resmi CLI/auth mekanizması üzerinden sağlanır.
- Resmi CLI/auth çalışma zamanı ile görev kodu farklı OS erişim yetkileri ve süreç/dosya sistemi sınırlarıyla ayrılır. Kimlik bilgisi yalnızca resmi auth çalışma zamanına açılabilir; görev konteynerine veya araç süreçlerine bağlanmaz ve bu süreçlerin ortam değişkenlerine aktarılmaz.
- **Salt okunur mount tek başına kimlik izolasyonu değildir.** Aynı kullanıcı veya mount namespace altında görev kodunun okuyabildiği bir kimlik dosyası kabul edilmez. Kimlik konumunun CLI'a bağlandığı bir tasarım ancak görev süreçlerinin dosya okuma, `/proc`, süreç belleği/ptrace, miras alınan ortam ve CLI dosya araçları üzerinden erişimi engellendiğinde kullanılabilir.
- CLI'ın dosya/komut araçları yalnızca görev sandbox'ına erişebilir. Host'ta çalışan bir broker kullanılırsa CLI sürecinin kendisinin de kişisel dosyalara, tarayıcı verilerine ve SSH anahtarlarına erişimi OS düzeyinde sınırlandırılır; yalnızca araç çağrılarını yönlendirmek yeterli değildir.
- Token yenilemesi ve oturumun sona ermesi resmi auth mekanizması üzerinden yönetilir. Salt okunur kimlik dosyası kullanan bir tasarımın yenileme sırasında çalıştığı ayrıca test edilir; yenileme için görev sandbox'ına yazılabilir kimlik konumu açılmaz.
- Kimlik bilgilerinin bulunmadığı görev sandbox'ı, temizleme ve paketleme işlemlerinin tek girdisidir. CLI auth dizini ve kişisel ayarlar çalışma dizininin dışında kalır.
- Kimlik bilgileri hiçbir durumda sonuç artifact'ına, checkpoint'e, log paketine veya koordinatöre gönderilen başka bir veriye dahil edilmez.
- Sonuç paketleri ve checkpoint'ler gönderilmeden önce istemcide otomatik **secret scanning** işleminden geçirilir; sunucu tarafında aynı tarama tekrarlanır.
- Platformun güvenlik modeli, kullanıcının yapay zekâ hesabını platform hesabına bağlamasına veya giriş bilgilerini platformla paylaşmasına dayanmaz.
- Secret scanning ek bir kontroldür; kimlik bilgisine erişimi engelleyen sınırın yerine geçmez. Desteklenen her ajan/platform birleşimi için kötü niyetli görev koduyla erişim testleri geçmeden entegrasyon yayımlanmaz.
- Sağlayıcının resmi giriş, binary dağıtımı, abonelik kullanımı ve otomasyon koşulları Faz 0'da incelenir; uyumluluk matrisi ve kaynaklar ADR'ye kaydedilir. Kontrol sağlayıcı/CLI değişikliklerinde ve lansman öncesinde tekrarlanır (§19).

### 6.4 Sandbox
- **Motor:** Docker / Podman. Linux'ta ek olarak gVisor (`runsc`) varsayılan.
- **İlk kurulum:** Uygulama Docker/Podman varlığını kontrol eder, yoksa kurulum sihirbazı açar.
- **İmajlar:** Proje türüne göre hazır imajlar (`lean-mathlib`, `node`, `python`, `rust`, `go`). İmajlar imzalıdır ve önbelleğe alınır.
- **Dosya sistemi:** Görev sandbox'ına yalnızca görev çalışma dizini bağlanır. Kullanıcı ve auth dizinleri, Docker/Podman soketi ve host cihazları bağlanmaz.
- **Ağ:** Görev kodu için varsayılan olarak kapalı. Model uç noktalarına erişim resmi CLI/auth çalışma zamanında, koordinatöre erişim istemcide tutulur. Göreve özel Git/package registry erişimi gerekiyorsa moderasyon ve kullanıcıya gösterilen izin listesiyle sınırlanır; kurulum ve çalışma aşamalarının izinleri ayrılır.
- **Kaynak sınırları:** CPU, RAM, disk ve süre sınırı görev tanımından alınır, kullanıcı ayarlarıyla üst sınırlanır.
- **Temizlik:** Görev bittiğinde konteyner ve geçici dosyalar silinir.

### 6.5 İstemci Tarafı Görev Akışı
1. Kullanıcı görev listesinden bir görev seçer veya sunulan atamayı onaylar; ajan/model, etkin süre sınırı, yerel bütçe ve varsa ağ izinlerini görerek **Başlat**'a basar (§6.9).
2. Koordinatörden görev için bir kiralama alınır.
3. Görev paketi indirilir ve hash'i doğrulanır.
4. Temiz bir sandbox oluşturulur ve çalışma alanı hazırlanır.
5. Repository, görev dosyaları, görev bağlamı ve varsa son doğrulanmış checkpoint çalışma alanına yerleştirilir.
6. Ajan değiştirilemez görev prompt'u, onaylı strateji seçimi ve varsa güvenilmeyen continuation context ile başlatılır; çıktı canlı olarak arayüzde gösterilir (§8.4).
7. Ajan çalışırken istemci, görev ayarlarına göre belirli aralıklarla yerel ara durum tutar.
8. Ajan bitirdiğinde istemci yerel ön kontrol komutunu çalıştırır.
9. Sonuç artifact'ı otomatik olarak oluşturulur ve kullanıcıya gösterilir.
10. Kullanıcı sonucu onaylayıp **Gönder**'e basar ya da çalışmayı durdurur.
11. Gönderilen sonuç paketi koordinatöre yüklenir ve sunucu tarafında bağımsız olarak doğrulanır (§9).
12. Görev yarıda bırakılırsa kullanıcı iki seçenekten birini seçer:
    - **İlerlemeyi Sil**
    - **Checkpoint Oluştur ve Devret** (§6.6)
13. Uygulama kapanması, bağlantı kaybı veya beklenmeyen hata durumunda, kurtarılabilir bir çalışma durumu varsa otomatik kurtarma checkpoint'i oluşturulur.
14. Doğrulama ve checkpoint durumu arayüzden takip edilir.

### 6.6 Checkpoint ve Handoff
Uzun süren veya tek bir gönüllünün tamamlayamadığı görevlerde emeğin kaybolmaması için çalışma başka bir katkıcıya devredilebilir. Gönüllü görevi bitirmeden ayrıldığında mevcut çalışma durumu bir **checkpoint** olarak kaydedilir. Görevi alan yeni gönüllü sıfırdan başlamak yerine son doğrulanmış checkpoint'ten devam eder. Handoff ajandan bağımsızdır: Claude Code ile başlanan bir görev Codex CLI ile devam ettirilebilir.

#### 6.6.1 Checkpoint Türleri
**Soft checkpoint** — ajanın mantıksal çalışma durumu: yapılanların özeti, mevcut plan, tamamlanan ve kalan alt adımlar, önemli keşifler, denenmiş ama başarısız yaklaşımlar, bilinen engeller, önerilen devam noktası ve kısa continuation prompt.

**Hard checkpoint** — soft checkpoint'e ek olarak çalışma alanının teknik durumu: base commit, mevcut git diff, değiştirilen ve üretilen dosyalar, test sonuçları, derleme durumu, ilgili hata logları ve çalışma alanını yeniden kurmak için gereken artifact'lar.

| Görev türü | Varsayılan checkpoint |
|---|---|
| Lean | Hard (kısmi `.lean` dosyası + soft özet) |
| Yazılım | Hard |
| Planlayıcı / araştırma | Soft |

> Lean görevlerinde kısmi ispat, orijinal iskeletteki kalan boşluklar `sorry` ile bırakılarak derlenebilir durumda tutulabilir. İlerleme, adlandırılmış milestone ispatının bağımlılıklarıyla birlikte doğrulanmasıyla ölçülür. Bir boşluğu başka bir çözülmemiş ispata taşımak veya yeni `sorry` eklemek ilerleme sayılmaz (§11.2).

#### 6.6.2 Checkpoint Oluşturma Anları
- Kullanıcı **Durdur ve Devret**'i seçtiğinde
- Görevdeki `checkpoint_interval_sec` aralıklarında otomatik
- Ajan önemli bir ara aşamayı tamamladığında
- Görev zaman sınırına yaklaştığında
- Uygulama kontrollü şekilde kapanırken
- Beklenmeyen hata sonrası kurtarılabilir durum bulunduğunda

#### 6.6.3 Güven Modeli
- Checkpoint içindeki ajan açıklamalarına ve ilerleme tahminlerine **güvenilmez**. `progress_estimate` gibi alanlar yalnızca bilgilendirme amaçlıdır.
- Doğrulanabilir durum mümkün olduğunca artifact'lardan belirlenir: commit, diff, Lean dosyaları, derleme çıktısı, test sonuçları ve sunucuda yeniden üretilebilen sonuçlar.
- Soft checkpoint metinleri (özet, continuation instructions vb.) bir sonraki ajan için **güvenilmeyen veri** olarak ele alınır (prompt injection riski, bkz. §12.3).
- Yeni gönüllü, önceki kullanıcının host ortamını veya çalışan süreç durumunu asla devralmaz; devredilen çalışma her zaman yeni ve temiz bir sandbox içinde yeniden kurulur.

#### 6.6.4 Handoff Akışı
```text
Worker A görevi çalıştırır
   ↓
Bitirmeden ayrılır → checkpoint oluşturulur
   ↓
Koordinatör checkpoint'i doğrular ve saklar
   ↓
Görev "devam ettirilebilir" olarak yeniden açılır
   ↓
Worker B görevi alır → son doğrulanmış checkpoint temiz sandbox'a yüklenir
   ↓
Yeni ajan kompakt continuation context ile başlatılır
   ↓
Çalışma kaldığı yerden devam eder
```

Yeni ajana önceki konuşma geçmişinin tamamı verilmez; sistem önceki çalışmayı özetleyerek kompakt bir continuation context oluşturur. Context için üst sınır vardır (varsayılan 8.000 token).

#### 6.6.5 Örnek Checkpoint
```json
{
  "checkpoint_id": "cp-7",
  "task_id": "software-1842",
  "lease_id": "lease-991",
  "parent_checkpoint_id": "cp-6",
  "type": "hard",
  "base_commit": "a1b2c3d",
  "progress_estimate": 0.37,
  "summary": "Parser migration partially complete.",
  "completed": ["Tokenizer ported", "AST structures created"],
  "remaining": ["Error handling", "Fix 3 failing tests"],
  "failed_approaches": ["Direct lifetime mapping caused borrow-checker issues"],
  "continuation_instructions": "Continue from parser.rs and resolve the remaining lifetime errors.",
  "test_status": { "passed": 41, "failed": 3 },
  "workspace_artifact": "s3://.../checkpoint.tar.zst",
  "created_at": "..."
}
```

Lean checkpoint'lerinde `test_status` yerine şu alan kullanılır:
```json
"lean_status": { "compiles": true, "skeleton_holes_total": 5, "skeleton_holes_closed": 3, "milestones_passed": ["m1", "m3"] }
```

### 6.7 Arayüz Ekranları
- **Keşfet:** Projeler, kategoriler, zorluk, açık görev sayısı.
- **Proje Detayı:** Açıklama, arama ağacı görselleştirmesi (aktif, umut veren, durmuş, kapatılmış dallar), bütçe kullanımı, orkestratör karar günlüğü, ilerleme, katkıcılar.
- **İnceleme:** `verified_candidate` durumundaki sonuçların diff'i, doğrulama raporu ve milestone sonuçları; onay / ret / değişiklik iste.
- **Proje Sahibi Paneli:** Bütçe ve orkestratör politikası, düğüm müdahaleleri (sabitle, kapat, yeniden aç, öncelik ver), inceleme politikası, milestone tanımları.
- **Görev Detayı:** Tanım, önceki başarısız denemelerin özetleri, tahmini süre, önerilen ajan, görev durumu etiketi (`Yeni görev` / `Devam ettirilebilir` / `Checkpoint mevcut`).
- **Çalışma Ekranı:** IDE benzeri dosya ağacı, editör/diff görünümü, sandbox terminali, canlı ajan çıktısı ve doğrulama raporu; kaynak kullanımı, kalan yerel bütçe, **Checkpoint Kaydet** ve **Durdur ve Devret** butonları. Terminal ve editör işlemleri görev izinleriyle sınırlandırılır; görev devralındıysa önceki çalışmanın özeti gösterilir.
- **Devralma Ekranı:** Checkpoint'li bir görev alınırken önceki çalışmanın doğrulanmış özeti gösterilir:
  ```text
  Bu görev daha önce başka bir katkıcı tarafından çalıştırıldı.

  Önceki çalışma (doğrulandı):
  • 41 test geçiyor, 3 test başarısız
  • Tokenizer tamamlandı, error handling tamamlanmadı

  [Checkpoint'ten Devam Et]   [Sıfırdan Başla]
  ```
  Varsayılan seçenek checkpoint'ten devam etmektir. Sayısal bilgiler (test, `sorry` sayısı) sunucunun doğruladığı değerlerden gelir; ajanın beyanından değil.
- **Gönderilerim:** Gönderilen sonuçlar ve doğrulama durumları.
- **Profil:** Puan, itibar, rozetler, katkı geçmişi.
- **Ajanlar:** Kurulu ajanlar, giriş durumu, sürüm.
- **Ayarlar:** Kaynak sınırları, katkı bütçesi, ücretli kullanım izni, sandbox, dil, bildirimler.

### 6.8 Güncellemeler
- İmzalı otomatik güncellemeler (Tauri updater).
- Sandbox imajları ve adaptörler ayrı kanaldan güncellenir.

### 6.9 Kullanıcı Katkı Bütçesi
- Kullanıcı tek denemenin azami süresini, günlük toplam aktif çalışma süresini ve eşzamanlı deneme sayısını belirler; eşzamanlılık varsayılanı 1'dir. CPU/RAM/disk sınırları ayrıca uygulanır. Birden fazla cihazın günlük sınırları cihaz bazında gösterilir; hesap genelindeki eşzamanlı kiralama sınırı koordinatörde uygulanır.
- Etkin süre sınırı; görev limiti, proje politikası ve kullanıcının kalan yerel bütçesinin en küçüğüdür. Orkestratör kullanıcı sınırlarını artıramaz. Limit dolunca yeni görev başlatılmaz; çalışan deneme güvenli biçimde durdurulur ve izin veriliyorsa checkpoint oluşturulur.
- Sağlayıcının kullanım limiti veya oturum hatası uygulamada ayrı bir durumdur; otomatik yeniden deneme fırtınası oluşturulmaz ve yeniden başlatma kullanıcı kontrolündedir.
- Abonelik erişiminden ücretli API kullanımına **otomatik geçiş yapılmaz**. Ücretli mod varsayılan olarak kapalıdır; kullanıcı ayrı bir seçimle açar ve destekleniyorsa parasal üst sınır belirler. Güvenilir parasal sınır uygulanamayan entegrasyonda bu durum başlatmadan önce açıkça gösterilir.
- Süre, CLI'ın bildirdiği token/kullanım verisi, tahmini maliyet ve sağlayıcının kalan kota bilgisi ayrı gösterilir. Desteklenmeyen veya ölçülemeyen bilgiler `bilinmiyor` olarak gösterilir; ajan-saati abonelik tüketimi veya garanti edilen maliyet diye sunulmaz. İstemci ölçümleri puan kazandırmaz.

---

## 7. Koordinatör Sunucu

### 7.1 Sorumluluklar
- Kimlik doğrulama (GitHub, Google, e-posta)
- Proje ve görev yönetimi
- Görev kiralama ve zaman aşımı
- Sonuç alma ve doğrulama kuyruğuna iletme
- Puan ve itibar hesaplama
- Moderasyon iş akışları
- Gerçek zamanlı bildirimler (WebSocket)

### 7.2 API Uç Noktaları (özet)

| Yöntem | Yol | Açıklama |
|---|---|---|
| GET | `/projects` | Projeleri listele |
| GET | `/projects/{id}` | Proje detayı ve özet ilerleme |
| POST | `/projects` | Proje oluştur (proje sahibi) |
| POST | `/projects/{id}/tasks` | Görev ekle |
| GET | `/tasks?status=open` | Açık görevler |
| POST | `/tasks/{id}/lease` | Görevi kirala |
| POST | `/leases/{id}/heartbeat` | Kiralamayı canlı tut |
| DELETE | `/leases/{id}` | Kiralamayı bırak |
| POST | `/leases/{id}/result` | Sonuç gönder |
| GET | `/submissions/{id}` | Doğrulama durumu |
| GET | `/users/{id}` | Profil ve istatistikler |
| GET | `/leaderboard` | Liderlik tablosu |
| POST | `/moderation/tasks/{id}` | Görev onayla/reddet |
| POST | `/leases/{id}/checkpoint` | Mevcut çalışmadan checkpoint oluştur |
| GET | `/tasks/{id}/checkpoints` | Göreve ait kullanılabilir checkpoint'ler |
| POST | `/tasks/{id}/resume` | Son uygun checkpoint üzerinden yeni kiralama |
| GET | `/checkpoints/{id}` | Checkpoint metadata ve doğrulama durumu |
| DELETE | `/checkpoints/{id}` | Checkpoint'i sil |
| GET | `/projects/{id}/tree` | Arama ağacı ve düğüm durumları |
| GET | `/projects/{id}/decisions` | Orkestratör karar günlüğü |
| PUT | `/projects/{id}/policy` | Bütçe ve orkestratör politikası (sahip) |
| POST | `/nodes/{id}/override` | Düğümü sabitle / kapat / yeniden aç / öncelik ver (sahip, moderatör) |
| GET | `/reviews?status=pending` | Bekleyen incelemeler |
| POST | `/submissions/{id}/review` | Onayla / reddet / değişiklik iste |

Normal kullanıcı yalnızca kendi oluşturduğu ve henüz kimse tarafından devralınmamış checkpoint'i silebilir. Moderatör ve yöneticiler geçersiz checkpoint'leri kaldırabilir.

### 7.3 Kiralama Kuralları
- Varsayılan kiralama süresi denemenin etkin `time_limit_sec` değeri + %20; bu ek süre sonuç/checkpoint teslimi içindir, ajanın çalışma süresini uzatmaz.
- İstemci her 60 saniyede heartbeat gönderir; 3 heartbeat kaçırılırsa kiralama düşer.
- Bir görevin aynı anda kaç kişiye kiralanacağı sabit değildir: orkestratör bunu görevin `parallelism.initial` ile `parallelism.cap` aralığında dinamik olarak belirler (§10.4).
- **Bağımsız mod (`independent`):** Her deneme aynı base commit ve görev sözleşmesinden, eşzamanlı diğer denemelerin çıktısını görmeden çalışır; onaylı stratejiler farklı olabilir. Matematik için varsayılandır. İlk `verified_candidate` bulunduğunda görev `awaiting_review` olur, yeni kiralama açılmaz ve diğer çalışanlara güvenli durdurma/checkpoint isteği gönderilir. Kalıcı kazanan `accepted` aşamasında belirlenir; kalan kiralamalar o zaman iptal edilir (§9.6).
- **Sıralı mod (`exclusive`):** Görev aynı anda tek kişidedir; ilerleme checkpoint/handoff zinciriyle aktarılır. Ortak çalışma alanı gerektiren yazılım görevleri için varsayılandır.
- Bir kullanıcı aynı görevde aynı anda yalnızca bir kiralama tutabilir.
- Aynı kullanıcı aynı görevi geçersiz sonuçla başarısız olduktan sonra 24 saat tekrar alamaz (farklı kişilerin denemesini teşvik eder). Sağlayıcı kotası, oturum/altyapı hatası, kullanıcı bütçesi nedeniyle durdurma ve `changes_requested` bu kısıtın veya itibar cezasının nedeni değildir.
- Kiralama düştüğünde bekleyen aday veya kabul edilmiş sonuç yoksa son doğrulanmış checkpoint bulunan görev `resumable` durumuna geçer. Bağımsız denemelerin ortak başlangıç durumunu değiştirmek yeni bir görev sürümü gerektirir.
- İnceleme için durdurma, CLI'ın belleğini dondurmaya dayanmaz: istemci ajanı durdurur, izin verilen ara durumu kaydeder ve kiralamayı `paused_for_review` olarak onaylar. Kullanıcı kapasitesi serbest bırakılır; durdurulamayan süreç yerel süre sınırında sonlandırılır. Devam için kullanılabilir checkpoint'ten yeni sandbox ve yeni kiralama oluşturulur.
- Kiralamalar görev sürümü, `contract_hash` ve deneme kimliğine bağlıdır. Gönderim/checkpoint istekleri idempotent işlenir; süresi dolmuş, eski sürüme ait veya iptal edilmiş kiralama mevcut görev durumunu ve puanı değiştiremez. Geç sonuçlar gerekçeli ret alır; yerel kurtarma verisi korunur.

### 7.4 Veri Modeli (ana tablolar)
- `users` — id, kullanıcı adı, puan, itibar, roller
- `projects` — id, sahip, tür, başlık, açıklama, depo, durum
- `tasks` — id, task_version, contract_hash, proje, type, kind, şema JSON, durum, bağımlılıklar, öncelik
- `leases` — id, görev sürümü, contract_hash, deneme kimliği, kullanıcı, başlangıç, son heartbeat, durum, etkin süre sınırı, strategy_id
- `submissions` — id, kiralama, ajan profili, sonuç dosyası (S3), doğrulama durumu, log, client_reported_usage
- `nodes` — id, project_id, parent_id, relation (and/or), state, goal, budget_allocated, budget_spent, last_progress_at
- `tasks` ↔ `nodes` — her görev bir düğüme bağlıdır
- `orchestrator_decisions` — id, project_id, node_id, decision_type, inputs (sinyal özeti), result, actor (orkestratör/sahip/moderatör), created_at
- `agent_stats` — düğüm, görev türü/kind, sağlayıcı, CLI/adaptör sürümü, model/sürüm, reasoning ayarı ve strategy_id bazında deneme, sunucuda doğrulanmış başarı, kiralama süresi; metadata kaynağı
- `reviews` — id, submission_id, reviewer_id, decision, comments, created_at
- `attempt_notes` — başarısız denemelerden çıkarılan özetler
- `checkpoints` — id, task_id, task_version, contract_hash, lease_id, user_id, parent_checkpoint_id, type (soft/hard), base_commit, summary, continuation_context, workspace_artifact, progress_estimate, test_status / lean_status, verification_status, created_at, expires_at

`parent_checkpoint_id`, çalışma zincirinin izlenmesini sağlar:
```text
Task
 └── CP1 — Worker A
       └── CP2 — Worker B
             └── CP3 — Worker C
                   └── Final Submission
```
- `moderation_events` — inceleme kayıtları
- `badges`, `user_badges`

### 7.5 Kalıcı Sunucu İş Akışları

- **Tercih:** Temporal Go SDK; F0 kesinti/retry denemesi ve staging işletim/maliyet değerlendirmesi sonrası production entegrasyonu. Açık kaynak seçiminin gerekçesi `docs/OPEN_SOURCE_SELECTION.md` içinde tutulur.
- Koordinatör ve PostgreSQL; görev sürümü/hash'i, yetki, kiralama, atomik bütçe rezervasyonu, aday kabulü ve puan için yetkili kaynaktır. Temporal problem ayrıştırma veya kapasite dağıtımı algoritmasının yerine geçmez.
- Deneme/kiralama başına workflow; zaman aşımı, doğrulama, inceleme ve handoff beklemeleri sunucuda sürdürülür. Masaüstü olayları yalnız kimlik/yetki/sözleşme kontrolünden sonra workflow'a iletilir.
- Domain değişikliği ve workflow olayı aynı PostgreSQL transaction'ında **outbox** kaydıyla bağlanır. Teslimat tekrar edebilir; sabit olay kimliği, deduplication ve uzlaştırma uygulanır. Workflow/Activity retry'si tek başına exactly-once yan etki güvencesi değildir.
- Doğrulama Job'u, sonuç ve puan işlemlerinde sabit idempotency anahtarı kullanılır. Workflow history yalnız gerekli kimlik/hash/referansları taşır; ham prompt, kimlik bilgisi, ajan logu ve artifact içeriği eklenmez. Checkpoint nesneleri S3'tedir.
- Temporal retry'si kullanıcı CLI'ını yeniden başlatamaz veya yeni katkı harcamasına izin veremez. Masaüstünde devam, yeni onay/kiralama ve temiz sandbox gerektirir. Activity heartbeat ile gönüllü lease heartbeat'i ayrı mekanizmalardır.
- Redis yalnız ihtiyaç varsa cache/rate limit için kullanılır; kalıcı görev yaşam döngüsünün sahibi değildir. Doğrulayıcı ilk tasarımda Kubernetes Job kullanır; Argo ayrı workflow motoru olarak eklenmez.
- Deployment, retention/history büyüklüğü, sürüm yükseltme/replay, yedekleme/geri yükleme, maliyet ve gözlemlenebilirlik staging kabulüne dahildir. Tek makinedeki development-server denemesi production HA kanıtı değildir.

---

## 8. Görev Formatı

### 8.1 Şema
```json
{
  "schema_version": "1.0",
  "id": "string",
  "task_version": 1,
  "contract_hash": "sha256 — değiştirilemez görev alanlarının kanonik hash'i",
  "project_id": "string",
  "type": "lean | software",
  "kind": "solve | plan | refute | rebase",
  "title": "string",
  "description": "string (markdown)",
  "prompt": "string — ajana verilecek talimat",
  "strategies": [
    { "id": "default", "instructions": "string — onaylı, görev hedefini değiştirmeyen yaklaşım" }
  ],
  "workspace": {
    "repo": "git url",
    "commit": "sha",
    "entry_files": ["string"],
    "writable_paths": ["string"]
  },
  "environment": {
    "image": "lean-mathlib@sha256:<sabitlenmiş-digest>",
    "cpu": 4,
    "memory_mb": 8192,
    "time_limit_sec": 3600
  },
  "verification": {
    "profile": "lean-proof | software-tests | planner-proposal",
    "local_precheck": "string — istemcide çalışacak komut",
    "server_command": "string — doğrulayıcıda çalışacak komut",
    "output_schema": "string — beklenen artifact/JSON şeması kimliği",
    "forbidden_patterns": ["string"]
  },
  "depends_on": ["task_id"],
  "difficulty": "easy | medium | hard | open",
  "node_id": "string",
  "parallelism": {
    "mode": "independent | exclusive",
    "initial": 3,
    "cap": 50
  },
  "agents": {
    "preferred": ["claude-code"],
    "excluded": []
  },
  "progress": {
    "milestones": [
      { "id": "m1", "name": "string", "check": "string — sunucu komutu veya iskelet boşluğu adı", "weight": 0.4, "critical": true }
    ]
  },
  "review": {
    "policy": "auto | maintainer | community",
    "required_approvals": 1
  },
  "reward_points": 100,
  "handoff": {
    "enabled": true,
    "checkpoint_interval_sec": 900,
    "max_checkpoints": 5,
    "allow_workspace_snapshot": true,
    "resume_from_latest": true
  }
}
```

### 8.2 Örnek — Lean Görevi
```json
{
  "id": "nt-0042",
  "type": "lean",
  "kind": "solve",
  "title": "Lemma: asal sayıların karesi mod 24",
  "prompt": "Projects/NT/Lemma42.lean dosyasındaki `sorry` yerine geçerli bir ispat yaz. Başka dosyayı değiştirme.",
  "workspace": {
    "repo": "https://github.com/org/nt-project",
    "commit": "a1b2c3d",
    "entry_files": ["Projects/NT/Lemma42.lean"],
    "writable_paths": ["Projects/NT/Lemma42.lean"]
  },
  "verification": {
    "local_precheck": "lake build Projects.NT.Lemma42",
    "server_command": "lake build Projects.NT.Lemma42",
    "forbidden_patterns": ["sorry", "admit", "axiom", "native_decide"]
  }
}
```

### 8.3 Örnek — Yazılım Görevi
```json
{
  "id": "port-0117",
  "type": "software",
  "kind": "solve",
  "title": "parser.c → parser.rs taşıma",
  "prompt": "src/parser.c dosyasını Rust'a taşı. tests/parser_tests.rs içindeki tüm testler geçmeli.",
  "workspace": {
    "writable_paths": ["src/parser.rs"]
  },
  "verification": {
    "server_command": "cargo test --test parser_tests"
  }
}
```

### 8.4 Orkestratörün Değiştirebileceği Alanlar
Proje sahibinin tanımladığı alanlar sözleşmedir. `prompt`, `strategies`, workspace/base commit, ortam imajı, `verification`, `progress` ve `review` değiştirilemez; değişiklik yeni görev sürümü ve `contract_hash` üretir. Orkestratör yalnızca aktif paralellik, denemenin etkin süre limiti, ajan önerisi ve öncelik gibi çalışma ayarlarını sahibin politikası ve kullanıcı sınırları içinde değiştirir.

Hash girdisi F0 JSON Schema'da açıkça tanımlanır; `contract_hash` alanının kendisi ve değişken çalışma ayarları hash girdisine girmez. Checkpoint aynı sözleşmeye bağlıdır; yeni base commit/sözleşmede kullanılacaksa açık bir taşıma ve yeniden doğrulama gerekir.

Prompt çeşitliliği, sözleşmede önceden onaylanmış `strategies` arasından seçimle sağlanır. Denemeye verilen `execution_context`, `strategy_id`, seçilen ajan/model profili ve etkin limitleri taşır; görev hedefini veya kabul kriterlerini değiştiremez. Yeni strateji önerisi planlayıcı çıktısıdır; onaylandıktan sonra yeni görev sürümüne eklenir. Checkpoint ve başarısızlık notları ayrıca güvenilmeyen bağlam olarak verilir.

### 8.5 Handoff Ayarları
- `handoff.enabled = false` olan görevlerde checkpoint oluşturulmaz; kısa veya hassas görevler proje sahibi tarafından devredilemez olarak işaretlenebilir.
- `max_checkpoints`, bir görevde saklanan checkpoint zincirinin üst sınırıdır; aşıldığında en eski ve zincir dışı kalan checkpoint'ler silinir.

### 8.6 Görev Türleri ve Çıktı Sözleşmesi
`type` problem alanını, `kind` yapılacak işi belirtir. Şemada `kind` ile `verification.profile` uyumu zorunludur. §8.2 ve §8.3 yalnızca ilgili alanları gösteren kısmi örneklerdir; çalıştırılabilir paket §8.1'deki zorunlu alanları içermelidir.

| Kind | Çıktı | Doğrulama ve tamamlanma |
|---|---|---|
| `solve` | Lean ispatı veya yazılım diff'i | Sabit hedef/test sözleşmesi, ardından inceleme/birleştirme |
| `plan` | `proposal.json` ve gerekiyorsa Lean bağlantı ispatı | JSON Schema, hedef ilişkileri, DAG kontrolü ve §10.4 ayrıştırma kontrolleri; tamamlanması üst problemi çözülmüş yapmaz |
| `refute` | Sabitlenmiş hedefin olumsuzlamasına ispat veya yeniden üretilebilir karşı örnek | Lean axiom/type denetimi veya sunucuda karşı örnek kontrolü; çürütülen hedef açıkça kaydedilir |
| `rebase` | Kaynak adayı belirli hedef commit'e taşıyan diff | Yeni base commit sözleşmesi, tüm ilgili doğrulamalar ve yeniden inceleme |

Planlayıcı önerisi; hedef düğüm ve sözleşme hash'i, AND/OR ilişkisi, alt hedeflerin sabit ifadeleri, bağımlılıklar, her görev için doğrulama profili ve milestone'lar, kaynak sınırları, önerilen stratejiler ve bağlantı artifact'larını içerir. Orkestratör mevcut sözleşmeyi değiştirmez; yalnızca doğrulanıp proje politikasınca kabul edilen öneriden yeni görev sürümleri oluşturur. Alt görevler proje izinlerini genişletemez ve kendilerine daha zayıf doğrulama kuralları tanımlayamaz.

---

## 9. Doğrulama Sistemi

### 9.1 Genel Akış
1. Sonuç paketi alınır, boyut ve format kontrolü yapılır.
2. `writable_paths` dışında değişiklik varsa → **reddedilir**.
3. `forbidden_patterns` taraması.
4. Çıktı sözleşmesine göre diff/artifact temiz doğrulayıcıda orijinal commit üzerine uygulanır veya planlayıcı JSON'u sabit hedef bağlamıyla yüklenir.
5. `verification.profile` için sunucuda sabitlenmiş harness ve `server_command` çalıştırılır; çıktı şeması ve göreve özel kabul kontrolleri uygulanır (§8.6).
6. Başarılı → sonuç **`verified_candidate`** olur ve inceleme akışına girer (§9.6). Görev `awaiting_review` olur; yeni compute ayrılmaz, diğer denemeler §7.3'e göre güvenli durdurulur.
7. Başarısız → hata logu özetlenir, `attempt_notes`'a eklenir. Görev ancak başka bekleyen aday veya kabul edilmiş sonuç yoksa yeniden kiralanabilir olur.

### 9.2 Lean Doğrulayıcı
- Lean/Mathlib sürümleri, bağımlılık manifest'i ve imaj digest'i sabitlenir. Yalnızca platformun güvenilir bağımlılıklar için ürettiği `.olean` önbelleği kullanılır; gönüllüden derlenmiş ispat önbelleği alınmaz.
- Nihai ispatın transitif axiom bağımlılıkları yalnızca izinli standart aksiyomları (`propext`, `Classical.choice`, `Quot.sound`) içermelidir; `sorryAx`, özel aksiyomlar ve izin verilmeyen native değerlendirme aksiyomları reddedilir. `#print axioms` çıktısı adayın değiştiremediği doğrulama harness'i tarafından üretilir.
- Teorem ifadesi ve kullandığı tanımlar güvenilir, değiştirilemeyen challenge ortamında sabitlenir. Yalnızca kaynak metni karşılaştırmak yeterli değildir; elaborated teorem tipi ve tanım bağımlılıkları karşılaştırılır.
- Güvenilmeyen kod sandbox içinde derlenir; ispat yeniden kontrolü ve hedef karşılaştırması aday kodunun etkileyemediği ortamda yapılır. Resmi Lean doğrulama rehberindeki `comparator`/bağımsız checker yaklaşımı teknik denemeyle değerlendirilir (§19); seçilen harness'in tehdit kapsamı ve saldırı testleri kaydedilir.

### 9.3 Yazılım Doğrulayıcı
- Testler, gönüllünün değiştiremeyeceği gizli test setiyle birlikte çalıştırılır (görünür testler + sunucuda gizli testler).
- Lint ve format kontrolleri.
- Değişiklik boyutu sınırı.

### 9.4 Hile Önleme
- Sonuç her zaman sunucuda yeniden üretilir; istemci çıktısına güvenilmez.
- Test dosyalarının, doğrulama betiklerinin veya teorem ifadelerinin değiştirilmesi otomatik ret.
- Şüpheli kalıplar (örn. testi atlayan kod) moderasyon kuyruğuna düşer.
- Tekrarlayan geçersiz gönderim → itibar düşer, kiralama hakkı sınırlanır.

### 9.5 Checkpoint Doğrulaması
Checkpoint nihai sonuç değildir ve görevi çözülmüş durumuna getirmez. Amacı, devredilecek çalışma durumunun güvenli ve yeniden kullanılabilir olduğunu doğrulamaktır; nihai doğrulama kadar kapsamlı olması gerekmez.

1. Paket boyutu ve formatı kontrol edilir.
2. `writable_paths` dışındaki değişiklikler reddedilir (build betikleri, git hook'ları, test dosyaları dahil).
3. Secret scanning uygulanır.
4. Soft checkpoint metinleri uzunluk sınırı ve şüpheli talimat taramasından geçer (§12.3).
5. Yazılım görevlerinde diff'in `base_commit` üzerine temiz uygulandığı kontrol edilir; varsa hızlı testler çalıştırılır ve `test_status` sunucu sonucuyla değiştirilir.
6. Lean görevlerinde dosyanın derlendiği ve hedef/tanım ortamının değişmediği kontrol edilir. Yalnızca iskelette izin verilen çözülmemiş boşluklar kalabilir; yeni boşluk veya yasak axiom bağımlılığı checkpoint'i geçersiz yapar. Milestone'ların transitif bağımlılıkları ayrıca denetlenir (§11.2); derlenebilir olmak tek başına ilerleme değildir.
7. Geçerli checkpoint `usable` olarak işaretlenir. Yeni kullanıcıya yalnızca `usable` checkpoint verilir.
8. Geçersizse görev son geçerli checkpoint'ten veya başlangıç durumundan devam eder.

### 9.6 İnceleme ve Birleştirme
Otomatik doğrulamayı geçmek, sonucun ana depoya girmesi için tek başına yeterli değildir. Gizli testler yalnızca test edileni kontrol eder; okunabilirlik, mimariye uygunluk, performans veya testlerin kapsamadığı davranışlar ayrıca değerlendirilmelidir.

**Sonuç durumları:**
```text
submitted → verifying → verified_candidate → in_review → accepted → merged
                 ↓                                ↓
              rejected                    changes_requested / rejected
```

**İnceleme politikaları** (görev veya proje bazında):
| Politika | Kim onaylar | Varsayılan kullanım |
|---|---|---|
| `auto` | Kimse; doğrulama yeterli | Lean görevleri (ispat çekirdek tarafından kontrol edildiği için) |
| `maintainer` | Proje sahibi veya atadığı bakımcılar | Yazılım görevlerinin varsayılanı; kritik projelerde zorunlu |
| `community` | `required_approvals` kadar yüksek itibarlı gözden geçirici | Büyük açık kaynak projeleri |

**Kurallar:**
- Aynı görev için birden fazla aday varsa inceleme ekranında yan yana gösterilir; orkestratör adayları doğrulama metriklerine (diff boyutu, performans testleri, lint) göre sıralar, seçimi gözden geçirici yapar.
- Bir aday doğrulama sırasında bulunmuş diğer adayları geçersiz kılmaz. Tek kazanan seçimi atomik yapılır; `accepted` sonrası diğer kiralamalar kalıcı iptal edilir ve görev yeni denemelere kapanır. Düğüm ancak gerekli birleştirme/entegrasyon doğrulaması tamamlanınca `solved` olur. `auto` politikasında doğrulama ve kabul aynı akışta gerçekleşir.
- Aday hazırlanırken ana depo ilerlemişse sonuç otomatik olarak yeni commit'e taşınır (rebase) ve **yeniden doğrulanır**. Çakışma varsa orkestratör bir "rebase görevi" açar.
- `changes_requested` durumunda gözden geçirici notları `attempt_notes`'a eklenir. Başka bekleyen aday yoksa görev aday üzerinden, yeni kiralama ve temiz sandbox ile devam edilebilir olur.
- `rejected` durumunda başka bekleyen aday veya kabul edilmiş sonuç yoksa görev son kullanılabilir checkpoint'ten veya başlangıç durumundan yeniden açılır; ret gerekçesi sonraki denemelere bağlam olarak verilir. Duraklatılmış çalışma kullanıcı onayı olmadan otomatik yeniden başlatılmaz.
- Gözden geçiriciler inceleme başına puan kazanır; sonradan geri alınan onaylar gözden geçiricinin itibarını düşürür.
- Görevin puanları `accepted` aşamasında dağıtılır (`auto` politikasında doğrulama anında).

---

## 10. Orkestratör ve Problem Ayrıştırma

### 10.1 Amaç
Yapay zekâ şirketleri zor problemleri sabit bir iş listesiyle değil; sonuçlara göre sürekli yeniden yönlendirilen çok sayıda ajanla çözer. Platformun karşılığı **orkestratördür**. Orkestratörün dört görevi vardır:
1. **Görev üretmek:** Sonuçlara ve tıkanmalara bakarak yeni görevler açmak.
2. **Compute dağıtmak:** Umut veren dallara daha fazla, durmuş dallara daha az çalışma ayırmak.
3. **Ajan çeşitlendirmek:** Bir ajan tıkandığında farklı ajanları ve yaklaşımları denemek.
4. **Dal kapatmak:** Sonuç vermeyen veya geçersizleşen dalları kapatıp bütçeyi geri kazanmak.

### 10.2 Arama Ağacı
Her proje bir arama ağacı olarak tutulur (§4). Kök düğüm projenin ana hedefidir.
- **AND düğümü (ayrıştırma):** Alt hedefler çözüldükten sonra üst hedefin bağlantı ispatı veya entegrasyon testleri yeniden doğrulanıp birleştirildiğinde çözülür. Alt görevlerin ayrı ayrı geçmesi yeterli değildir.
- **OR düğümü (alternatifler):** Aynı sabit üst hedefi sağlayan yaklaşımlardan birinin sonucu kabul edilip üst hedef doğrulaması tamamlandığında çözülür. Örn. aynı lemma için tümevarım ve çelişki yoluyla iki farklı ispat girişimi.
- Görev bağımlılıkları döngüsüzdür. Alt hedef kendi üst hedefine veya kendisine bağımlı olamaz; başka dallarda kullanılan doğrulanmış lemma/bileşenler DAG üzerinden referanslanır. Bir dalın kapatılması başka aktif dalların kullandığı artifact'ı silmez.

**Düğüm durumları:**
| Durum | Anlamı |
|---|---|
| `open` | Çalışılmaya hazır, henüz kaynak ayrılmadı |
| `active` | Üzerinde kiralama veya bütçe var |
| `promising` | Son dönemde doğrulanmış ilerleme var |
| `stalled` | Bütçe harcanıyor ama doğrulanmış ilerleme yok |
| `awaiting_review` | Doğrulanmış aday var; yeni compute ayrılmıyor, inceleme bekleniyor |
| `accepted` | Kazanan kabul edildi; birleştirme/üst hedef doğrulaması bekleniyor |
| `pruned` | Orkestratör veya sahip tarafından kapatıldı (arşivde, yeniden açılabilir) |
| `disproved` | Hedefin yanlış olduğu doğrulandı (Lean'de olumsuzlamasının ispatı) |
| `solved` | Çözüldü ve birleştirildi |

### 10.3 Sinyaller
Orkestratör ilerleme, dal kapatma ve puan kararlarında yalnızca **sunucunun doğruladığı** sonuçları ve kendi zamanlama kayıtlarını kullanır; ajanların ilerleme yüzdesi ve özetleri karar sinyali değildir. Model/profil metadata'sı istemciden geldiği için doğrulanmış model kimliği sayılmaz; yalnızca kaynağı belirtilen istatistiksel bir yönlendirme ipucudur ve katkı puanı/güven yetkisi kazandırmaz.
- Milestone ilerlemesi (ağırlıklı, §11.2) ve son ilerlemeden bu yana geçen süre
- Düğüme harcanan bütçe ve deneme sayısı
- Başarısız denemelerin hata türleri (derleme hatası, zaman aşımı, test başarısızlığı)
- Ajan/model/reasoning/strateji profili bazında, sunucuda doğrulanmış sonuçlardan üretilen başarı istatistikleri (`agent_stats`); metadata kaynağı ve örneklem büyüklüğüyle birlikte
- Checkpoint zincirlerindeki doğrulanmış ilerleme
- Çürütme sonuçları ve kardeş dalların durumu

### 10.4 Karar Döngüsü
Orkestratör olay tabanlı (sonuç doğrulandı/başarısız oldu, checkpoint alındı, kiralama düştü, inceleme sonuçlandı) ve ek olarak periyodik çalışır. Her döngüde şu kararları verir:

**a) Compute dağıtımı**
- Projenin bütçesi açık yaprak düğümler arasında bir **çok kollu bandit** yaklaşımıyla (Thompson sampling) dağıtılır: doğrulanmış ilerleme hızı yüksek dallar daha fazla pay alır, bütçenin bir kısmı (`exploration_ratio`) az denenmiş dallara ayrılır.
- Dağıtım somut olarak şu ayarlarla uygulanır: görevin aktif paralelliği (`initial`–`cap` arası), zaman sınırı, görev listesindeki öncelik ve önerilen ajan.
- Örnek: bir Lean lemmasında 3 bağımsız deneme başarısız olduysa ve dal hâlâ umut veriyorsa paralellik 3 → 12 → 50 şeklinde artırılabilir.
- Paralellik artışı otomatik olarak doğrusal fayda varsaymaz. Benzer hata/artifact kümeleri ve profil çeşitliliği izlenir; artış proje bütçesi, gönüllü arzı ve doğrulayıcı kapasitesiyle sınırlandırılır. `awaiting_review` ve `accepted` düğümlerine yeni compute ayrılmaz.

**b) Ajan seçimi**
- Her düğümde ajan/model/reasoning/strateji profili bazında sonuçlar tutulur. Bir profil aynı düğümde `k` kez başarısız olduysa (varsayılan 3), farklı profillere öncelik verilir; az örneklem kesin başarısızlık diye yorumlanmaz.
- Bağımsız modda çeşitlilik kuralı uygulanır: paralel denemeler mümkün olduğunca farklı ajan/model profillerine ve §8.4'teki onaylı stratejilere dağıtılır. Kullanıcının model seçimi ve yerel bütçesi korunur.
- Gönüllünün hangi ajana sahip olduğu onun kontrolündedir; orkestratör ajan zorlamaz, görevleri doğru gönüllülere öne çıkarır.

**c) Yeni görev üretimi**
- **Tıkanmış düğüm → planlayıcı görev:** Bir düğüm `stalled` olduğunda orkestratör, düğümü farklı şekilde ayrıştırmak için bir planlayıcı görev açar. Planlayıcıya başarısız denemelerin özetleri bağlam olarak verilir.
- **Alternatif yaklaşım:** Planlayıcı, mevcut düğüme yeni bir OR kardeşi (farklı ispat stratejisi, farklı uygulama yaklaşımı) önerebilir.
- **Çürütme görevi:** Bir ara lemma çok sayıda denemeye direnirse orkestratör, lemmanın yanlış olabileceği ihtimaline karşı "olumsuzlamasını ispatla / karşı örnek bul" görevi açar.
- **Rebase görevi:** Aday sonuç ana depo ile çakıştığında (§9.6).
- **Ayrıştırmanın doğrulanması:** `plan` çıktısı önce §8.6'nın yapı ve DAG kontrollerinden geçer. Lean'de bağlantı ispatı, sabit üst hedefi alt lemma ifadelerini açık parametreler/hipotezler olarak alarak ispatlamalıdır; bağlantı ispatında `sorryAx` veya yeni özel aksiyom bulunamaz. Böylece hangi alt hedeflerin varsayıldığı ayrı ayrı izlenir. Alt lemmaları `sorry` ile bırakıp derlemek tek başına kabul kriteri değildir.
- **Ayrıştırmanın yararlılığı:** Geçerli bağlantı ispatı alt hedeflerin doğru, daha kolay veya çözülebilir olduğunu kanıtlamaz. `False` alt hedefi, üst hedefi tekrar eden alt hedef, döngü ve derinlik/bütçe sınırı ihlali reddedilir. Genel ayrıştırmalar varsayılan olarak sahip/moderatör incelemesinden geçer. Otomatik kabul yalnızca proje sahibinin önceden onayladığı ayrıştırma şablonları ve sınırlar içinde mümkündür; onaylanmamış öneriler gözlem modunda tutulur, görev açmaz ve bütçe ayırmaz.
- **Yazılım ayrıştırması:** Her alt görevin doğrulama komutu ve milestone'ları yanında, üst hedef için değiştirilemeyen entegrasyon doğrulaması bulunur. Planlayıcı testleri zayıflatamaz veya çalışma/ağ izinlerini genişletemez. Kabul edilmiş plan görev açar; üst hedef ancak sonuçların birlikte doğrulanmasıyla çözülür.

**d) Dal kapatma**
- **Bütçe tükenmesi:** Dal, kendisine ayrılan bütçeyi doğrulanmış ilerleme olmadan harcadığında `stalled` olur; bir planlayıcı denemesinden sonra da ilerleme yoksa `pruned` olur.
- **Çürütme:** Bir lemmanın olumsuzlaması ispatlanırsa düğüm `disproved` olur; ona bağlı tüm AND dalı kapatılır.
- **Kardeş çözüldü:** OR düğümünde aday bulunduğunda kardeş denemeler güvenli durdurulur. Kazanan alternatif kabul edilip aynı üst hedefin doğrulaması tamamlandığında diğer alternatifler kalıcı kapatılır; aday reddedilirse §9.6'ya göre yeniden çalışma açılabilir.
- **Üst hedef çözüldü / geçersizleşti:** Alt dallar otomatik kapanır.
- Kapatılan dallar silinmez; arşivlenir, notları korunur ve sahip tarafından yeniden açılabilir.

### 10.5 Bütçe ve Politika
Proje sahibi orkestratörün sınırlarını belirler:
- Toplam zamanlama bütçesi (ajan-saati) ve dal başına üst sınır
- Görev başına paralellik tavanı
- `exploration_ratio` (keşif payı)
- Ayrıştırma önerilerinin otomatik kabul kuralları
- Dal kapatma eşikleri

Koordinatör bütçeyi kendi kiralama/durdurma kayıtlarından hesaplar; eşzamanlı N denemenin bir saat sürmesi N ajan-saati olarak yazılır. Bekleyen ve duraklatılmış süre bütçeye yazılmaz; iptal/durdurma isteği sonrası gecikme ayrı raporlanır ve onay/zaman aşımına kadar rezervasyon korunur. Bu kayıt gerçek model çıkarımını, token tüketimini veya kalan abonelik kotasını doğrulamaz. İstemci kullanım raporu ayrı ve `client_reported` olarak saklanır. Yeni kiralamadan önce en kötü durum süre rezervasyonu atomik yapılır; kapasite bütçesi kullanıcı katkı sınırlarını veya merkezi altyapı bütçesini aşamaz (§15).

Hazır politika şablonları:
| Şablon | Davranış |
|---|---|
| **Matematik — geniş arama** | Bağımsız mod, yüksek paralellik tavanı, yüksek keşif payı, agresif alternatif üretimi |
| **Yazılım — dar ve sıralı** | Sıralı mod, düşük paralellik, handoff ağırlıklı, ayrıştırmalar onaylı |
| **Dengeli** | Varsayılan |

### 10.6 Şeffaflık ve İnsan Müdahalesi
- Orkestratörün her kararı gerekçesiyle (`orchestrator_decisions`: hangi sinyaller, hangi karar) kaydedilir ve proje sayfasında herkese açık gösterilir.
- Proje sahibi ve moderatörler her kararı geçersiz kılabilir: düğümü sabitlemek, kapatmak, yeniden açmak veya öncelik vermek. İnsan kararları orkestratörün sonraki döngülerinde korunur.

### 10.7 Uygulama Notu
Orkestratörün kendisi sunucuda çalışan bir politika motorudur; sunucunun kendi yapay zekâ modeline ihtiyacı yoktur. Thompson sampling gibi rastlantısal kararlar için seed, politika sürümü ve girdiler kaydedilir; aynı girdilerle karar tekrar üretilebilir. Yaratıcılık gerektiren işler gönüllülerin ajanlarına verilen planlayıcı görevlerle yapılır; öneriler §8.6 ve §10.4 kontrolleri tamamlanmadan aktif ağaca eklenmez.

### 10.8 Geliştirme Boyunca Fayda Ölçümü
- Sabitlenmiş gerçek görev kümesinde eşit toplam zamanlama bütçesiyle üç yaklaşım karşılaştırılır: tek ajan, basit paralel denemeler ve yönlendirilmiş paralel denemeler. Duvar saati, doğrulanmış başarı ve merkezi doğrulama maliyeti birlikte raporlanır.
- İlk karşılaştırma Lean uçtan uca akışı çalışınca başlar; milestone ve orkestratör eklendikçe aynı harness genişletilir. Tek görevde tek başarı yeterli kanıt değildir; tekrarlar, başarısızlıklar, model/profil dağılımı ve örneklem belirsizliği raporlanır. Politika ayarı için kullanılan görevler değerlendirme görevlerinden ayrılır.
- Sentetik simülatör regresyon ve politika araştırması içindir. Gerçek model korelasyonu, handoff maliyeti ve kullanıcı davranışı gerçek görev testleriyle değerlendirilir. Kazanç gösterilemeyen politika düzeltilir veya önceki güvenilir politikaya dönülür; bulgular ADR ve yol haritasına işlenir.

---

## 11. Puan, İtibar ve Topluluk

- **Puan:** Çözülen görevden `reward_points`; zorluk ve ilk çözen olma bonusu.
- **İtibar:** Geçerli/geçersiz gönderim oranı, reddedilen checkpoint oranı, moderasyon geçmişi. Yüksek itibar zor görevlere erişim açar.
- **Rozetler:** İlk ispat, 100 görev, proje tamamlayıcı vb.
- **Katkı kaydı:** Her çözülen görev, katkıcının adıyla kamuya açık olarak kaydedilir; proje tamamlandığında tüm katkıcılar listelenir.
- **Liderlik tablosu:** Genel, proje bazlı, aylık.

### 11.1 Devredilen Görevlerde Puan Paylaşımı
Görev kabul edildiğinde puan, final sonuca giden checkpoint zincirindeki katkıcılar arasında paylaştırılır. Final gönderimi yapan %50 alır; kalan %50, zincirdeki her checkpoint'in **katkıda bulunduğu milestone ağırlığına** göre bölünür (§11.2). Final zincire girmeyen checkpoint'ler puan almaz.

### 11.2 Milestone Tabanlı İlerleme Ölçümü
Ham test sayısı veya ham `sorry` sayısı kolay manipüle edilir: bir görevde 100 basit test geçip asıl kritik test kalmış olabilir ya da bir ajan ispatı çok sayıda önemsiz boşluğa bölüp bunları kapatarak sahte ilerleme gösterebilir. Bu yüzden ilerleme her zaman **görevde önceden tanımlanmış milestone'lar** üzerinden ölçülür.
- Milestone'ları proje sahibi (veya onaylanmış bir planlayıcı ayrıştırması) tanımlar; her birinin sunucuda çalışan bir kontrolü ve bir ağırlığı vardır. Örnekler: ağırlıklı test grupları (kritik testler yüksek ağırlıklı), gizli test grupları, Lean iskeletindeki adlandırılmış boşluklar veya ara lemmalar.
- `critical: true` işaretli milestone'lar geçmeden görevin ilerlemesi en fazla %50 olarak gösterilir.
- Yalnızca görev tanımındaki milestone'lar sayılır; ajanların sonradan eklediği test veya boşluklar ilerleme değildir.
- Lean milestone'u, sabit ifadenin ispatı transitif olarak çözülmemiş `sorryAx` veya yasak aksiyomlara dayanmıyorsa geçer. Başka bir orijinal boşluğa bağımlı çözüm, o bağımlılık da doğrulanana kadar `blocked` sayılır; yerel boşluğun metinden kaldırılması puan veya ilerleme üretmez.
- İlerleme, gizli testler dahil sunucuda ölçülür; görünür testlere göre optimize edilmiş sonuçlar avantaj sağlamaz.
- **Gerileme:** Daha önce geçmiş bir milestone'u bozan checkpoint'in o milestone'dan payı sıfırlanır.
- Milestone tanımlanmamış görevlerde test grupları eşit ağırlıklı sayılır ve görev detayında "ilerleme ölçümü sınırlı" uyarısı gösterilir.

Aynı milestone sistemi orkestratörün sinyali olarak da kullanılır (§10.3); böylece puan sistemi ile compute dağıtımı aynı nesnel ölçüye dayanır.

---

## 12. Güvenlik

### 12.1 Tehdit Modeli

| Tehdit | Yön | Önlem |
|---|---|---|
| Sahte/manipüle sonuç | Gönüllü → Platform | Sunucuda yeniden doğrulama (§9) |
| Kötü niyetli görev metni (prompt injection) | Görev → Gönüllü | Görev moderasyonu, sandbox, ağ allowlist |
| Sandbox'tan kaçış | Görev → Gönüllü | gVisor, yetkisiz konteyner, salt okunur kök FS |
| Kimlik bilgisi sızıntısı | Görev → CLI/auth → Herhangi | Ayrı süreç/dosya yetkileri, görev araçlarında auth erişiminin reddi, ortam ve süreç okuma kısıtları; ek olarak secret scanning (§6.3) |
| Kötü niyetli derleme/test/ispat kodu | Gönüllü veya proje sahibi → Doğrulayıcı → Platform | Güçlendirilmiş worker izolasyonu, ağ ve servis kimliklerinin kapatılması, değiştirilemeyen doğrulama harness'i (§12.4) |
| Manipüle edilmiş checkpoint / zararlı workspace | Gönüllü → Sonraki gönüllü | Checkpoint doğrulaması (§9.5), writable path kontrolü, secret scanning, temiz sandbox'ta resume, çalıştırılabilir artifact'lara güvenmeme |
| Checkpoint metniyle prompt injection | Gönüllü → Sonraki gönüllünün ajanı | Soft checkpoint'i güvenilmeyen veri olarak etiketleme, uzunluk sınırı, şüpheli talimat taraması, sandbox ve ağ allowlist |
| Sahte ilerlemeyle orkestratörü yönlendirme | Gönüllü → Platform | Orkestratör yalnızca sunucuda doğrulanmış milestone sinyallerini kullanır (§10.3) |
| Zayıf veya kötü niyetli inceleme | Gözden geçirici → Proje | İtibar eşiği, çoklu onay, kritik projelerde `maintainer` zorunluluğu, geri alınan onaylarda itibar kaybı |
| Sahte istemci | Saldırgan → Platform | API oran sınırlama, itibar sistemi, doğrulama zaten sunucuda |
| Tedarik zinciri | Saldırgan → Gönüllü | İmzalı uygulama, imzalı imajlar, sabitlenmiş bağımlılıklar |
| Hesap ele geçirme | Saldırgan → Kullanıcı | OAuth girişi, opsiyonel 2FA |

### 12.2 Görev Moderasyonu
- Yeni proje sahiplerinin görevleri yayına girmeden önce moderatör onayından geçer.
- Görev prompt'ları otomatik olarak şüpheli talimatlar için taranır (dosya sistemi dışına çıkma, ağ isteği, kimlik bilgisi arama vb.).
- Gönüllüler görevleri raporlayabilir.

### 12.3 Checkpoint Metinlerinin Güvenliği
Bir önceki gönüllünün ajanının yazdığı özet ve devam talimatları, bir sonraki gönüllünün ajanına prompt olarak verilir. Bu, görev metinlerindekiyle aynı türden bir prompt injection yüzeyidir. Bu nedenle:
- Soft checkpoint metinleri ajana sistem talimatı olarak değil, açıkça işaretlenmiş "önceki katkıcının notları (güvenilmeyen veri)" bloğu olarak verilir; ajanın asıl talimatı her zaman görev tanımındaki `prompt`'tur.
- Metinler uzunluk sınırına tabidir ve kapsam dışı eylemleri (ağ isteği, çalışma alanı dışı dosya erişimi, kimlik bilgisi arama vb.) isteyen ifadeler için taranır; şüpheli checkpoint moderasyona düşer.
- Sandbox ve ağ kısıtlamaları, bu katmanların aşıldığı durumda bile gönüllünün sistemini korur.

### 12.4 Doğrulayıcı ve Paket Güvenliği
- Proje sahibinin doğrulama komutu dahil tüm build/test/Lean meta-code güvenilmeyen kod olarak çalıştırılır. Worker'ın koordinatöre, veritabanına, bulut metadata servisine ve Kubernetes kontrol düzlemine erişimi yoktur; service-account token'ı, platform sırrı veya Docker soketi bağlanmaz.
- Paket indirme ve sonuç yükleme yetkileri görev kodunun dışındaki güvenilir worker katmanında tutulur. Çalışma ağ erişimi varsayılan olarak kapalı, bağımlılıklar sabitlenmiş imaj/önbellekten sağlanır. Salt okunur güvenilir cache'e yalnızca platformun doğruladığı içerik eklenir.
- Kaynak ve süre sınırları, yetkisiz kullanıcı ve güçlendirilmiş runtime/VM izolasyonu uygulanır. Kubernetes Job oluşturmak tek başına sandbox güvencesi değildir.
- Paket açma ve diff uygulama sırasında path traversal, symlink ile izin sınırı aşma, arşiv bombası ve boyut sınırı kontrolleri yapılır. Test/harness dosyaları aday tarafından değiştirilemez; sonuç raporu ve ispat kontrolü güvenilir katmanda üretilir.

---

## 13. İşlevsel Olmayan Gereksinimler

| Alan | Hedef |
|---|---|
| Uygulama boyutu | < 30 MB (imajlar hariç) |
| Boşta RAM kullanımı | < 150 MB |
| API yanıt süresi (p95) | < 200 ms |
| Doğrulama süresi (Lean, p95) | < 5 dk |
| Eşzamanlı aktif gönüllü | 10.000+ (yatay ölçeklenebilir) |
| Erişilebilirlik | Sistem uptime %99,5 |
| Yerelleştirme | Türkçe, İngilizce (genişletilebilir i18n) |
| Erişilebilirlik (a11y) | Klavye ile tam kullanım, ekran okuyucu desteği |
| Gizlilik | Telemetri varsayılan olarak kapalı, açık rıza ile |

---

## 14. Teknoloji Yığını

| Katman | Teknoloji |
|---|---|
| Masaüstü çatı | Tauri 2 (Rust) |
| Masaüstü arayüz | React + TypeScript + Tailwind |
| IDE bileşenleri | Monaco Editor, xterm.js; arama ağacı için React Flow |
| Sandbox | Docker / Podman; Linux gVisor ve sunucu için Kata kabul benchmark'ı |
| Koordinatör | Go (Faz 0 kararı: `spike/adr/0001-foundations.md`) |
| Veritabanı | PostgreSQL |
| Kalıcı sunucu iş akışları | Temporal + Go SDK; F0 ve staging kabul kapıları (§7.5) |
| Önbellek / hız sınırı | Redis (ihtiyaç halinde) |
| Dosya depolama | S3 uyumlu nesne depolama |
| Doğrulayıcılar | Kubernetes üzerinde izole job'lar |
| Lean | Lean 4, Lake, Mathlib |
| Web sitesi | Next.js |
| Kimlik doğrulama | OAuth (GitHub, Google) |
| Gözlemlenebilirlik | Prometheus, Grafana, OpenTelemetry |
| İmaj güven zinciri | Cosign (digest + güvenilen yayıncı) ve Trivy |
| Politika | F2'de OPA değerlendirmesi; OS/Rust zorunlu sınırları ayrı |
| Git işlemleri | F1/F4'te git2-rs/libgit2 uyumluluk denemesi |

SWE-ReX F0 runtime/yönlendirme adayıdır; resmi CLI araçları ve kimlik sınırı kanıtlanmadan production bağımlılığı olmaz. Semgrep CE yazılım incelemesinde kendi veya uygun lisanslı kurallarla yardımcı sinyal olabilir. Bileşen sürümleri ve üçüncü taraf lisans bildirimleri envanterlenir; hazır kural paketleri motor lisansı ile aynı kabul edilmez. Firecracker/Argo ertelenir; BOINC ve SWE-agent mimari/benchmark referansıdır. Tree-sitter gerçek kod bağlamı ihtiyacına göre değerlendirilir.

---

## 15. Altyapı ve Dağıtım

- Koordinatör ve doğrulayıcılar Kubernetes üzerinde.
- Doğrulayıcı havuzu kuyruk derinliğine göre otomatik ölçeklenir.
- Mathlib derleme önbelleği paylaşımlı depolamada.
- Masaüstü uygulaması CI'da üç platform için derlenir, imzalanır (Apple notarization, Windows code signing).
- Ortamlar: geliştirme, staging, üretim.
- Merkezi maliyet bütçesi; doğrulayıcı CPU/RAM süresi, artifact depolama/egress, gözlemlenebilirlik ve inceleme yükünü kapsar. Gönüllü abonelikleri bu maliyetleri karşılamaz. Gönderim, checkpoint sıklığı ve doğrulama işi için kullanıcı/proje kotaları uygulanır; kuyruk ve maliyet tavanına gelindiğinde yeni kiralamalar yavaşlatılır veya bekletilir.
- F0'da maliyet modeli, F1'de gerçek doğrulama maliyeti ölçümü hazırlanır. F3–F5'te tekrarlar/handoff/orkestratör yükü eklenir; 10.000 eşzamanlı bağlantı hedefi doğrulayıcı throughput ve harcama sınırlarıyla birlikte test edilir.

---

## 16. Metrikler

Ürün ve büyüme için izlenecek ana metrikler:
- Aktif gönüllü sayısı (günlük/haftalık)
- Toplam ajan çalışma saati
- Çözülen görev ve tamamlanan proje sayısı
- Gönderim başına doğrulama başarı oranı
- Ajan bazında başarı oranı ve ortalama süre
- Model/sürüm/reasoning/strateji bazında başarı, örneklem büyüklüğü ve benzer başarısızlıkların oranı
- Eşit bütçeli tek ajan / basit paralel / yönlendirilmiş çalışma karşılaştırmalarında doğrulanmış kazanç
- Kullanıcı katkı limiti ve sağlayıcı kotası nedeniyle durdurma oranı; ücretli moda geçiş kontrolü ihlalleri
- Kurulum başarı oranı, ilk göreve ulaşma süresi, tekrar katkı verme oranı
- Doğrulama başına ve kabul edilmiş sonuç başına merkezi maliyet; kuyruk bekleme ve inceleme yükü
- Görev başına ortalama deneme sayısı
- Handoff oranı ve checkpoint'ten devam edilen görevlerin çözülme oranı
- Geçersiz checkpoint oranı
- Dal başına harcanan bütçe; kapatılan dalların oranı ve kapatıldıktan sonra yeniden açılıp çözülen dal oranı (yanlış kapatma göstergesi)
- Orkestratör kararlarının insanlar tarafından geçersiz kılınma oranı
- Aday sonuçların inceleme süresi ve kabul oranı

---

## 17. Yol Haritası (v1.0 sonrası)

- **Yerel model desteği:** Ollama / llama.cpp entegrasyonu, yerel modeller için yerleşik ajan döngüsü, GPU algılama ve model önerisi.
- Yeni ajan adaptörleri (topluluk eklentileri).
- Yeni proje türleri (veri etiketleme, araştırma özetleri vb.).
- Kurumsal proje sahipleri için özel projeler.
- Ortak araştırma kurumlarıyla resmi işbirlikleri.

---

## 18. Açık Sorular

Kesinleşen mimari tercihler: koordinatör Go; bileşen seçimleri [OPEN_SOURCE_SELECTION.md](docs/OPEN_SOURCE_SELECTION.md) içinde. Deneme sonuçları ve tarihli uygulama kayıtları [geliştirme tarihçesinde](docs/DEVELOPMENT_HISTORY.md) ve ADR'lerde tutulur.

- [ ] Ürün adı ve marka
- [ ] Temporal staging işletim/maliyet ve production outbox kabulü (§7.5)
- [ ] SWE-ReX/resmi CLI araç yönlendirmesi ve gVisor/Kata benchmark kararı
- [ ] İlk lansman projeleri hangileri olacak?
- [ ] Gizli test setleri proje sahibinden nasıl alınacak ve saklanacak?
- [ ] Moderatörler nasıl seçilecek?
- [ ] Barındırma sağlayıcısı ve bütçe
- [ ] Checkpoint artifact'larının saklama süresi (`expires_at` varsayılanı)
- [ ] Puan paylaşım oranlarının (%50/%50) kesinleştirilmesi
- [ ] Bandit parametreleri, varsayılan `exploration_ratio` ve dal kapatma eşikleri (simülasyonla ayarlanmalı)
- [ ] Topluluk incelemesine katılmak için gereken itibar eşiği
- [ ] Ajan/platform bazında kimlik izolasyonu tasarımı, token yenileme ve sağlayıcı uyumluluk matrisi (F0)
- [ ] Kullanıcı katkı limitlerinin varsayılanları ve ücretli modda uygulanabilir parasal sınırlar
- [ ] Planlayıcı çıktı şeması, onaylı ayrıştırma şablonları ve otomatik kabul sınırları
- [ ] Gerçek görev benchmark kümesi, tekrar sayısı, kazanç ve güvenlik kapısı eşikleri
- [ ] Merkezi maliyet tavanları, kullanıcı/proje doğrulama ve checkpoint kotaları

---

## 19. Resmi Entegrasyon ve Doğrulama Kaynakları

7 Ekim 2026 tarihli ilk kaynaklar aşağıdadır. 8 Ekim 2026 ticari kullanım incelemesi ve kaynakları [sağlayıcı uyumluluğu kaydında](docs/PROVIDER_COMPATIBILITY.md) tutulur. Kullanıcı, katılımcının kendi aboneliğiyle resmi CLI çalıştırma tasarımında geliştirmeye devam etmeyi seçti; API/yerel model yönüne geçiş yapılmadı. Bu tercih sağlayıcı kabulü veya teknik GO değildir. Faz 0 ve entegrasyon güncellemelerinde güncel metinler yeniden kontrol edilerek CLI sürümü, izin verilen kullanım şekli ve teknik kanıtlarla birlikte ADR'ye kaydedilir.

- [Claude Code — Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance): Ürün içinde değiştirilmemiş binary kullanımı, kullanıcının kendi resmi giriş akışı ve kimlik bilgisi aracılığına ilişkin koşullar. Resmi CLI çalıştırmak ile abonelik token'larıyla üçüncü taraf istek yönlendirmek ayrı değerlendirilir.
- [OpenAI Docs — Authentication](https://learn.chatgpt.com/docs/auth) ve [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode): Abonelik/API kimlik yöntemleri, headless çalıştırma, kimlik cache'i ve token yenilemesi. Headless auth desteği, güvenilmeyen görev koduyla kimlik izolasyonunun kanıtı değildir.
- [OpenAI Docs — ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source) ve [SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/): Ticari erişim, kullanıcıya ait kullanım ve plan paylaşımı sınırlamalarıyla birlikte değerlendirilir; topluluk abonelik havuzuna uygun alternatif kabul edilmez. CommonGrid'de uygulanmadı. Kullanılacaksa §6.3'ün yerel kimlik yönetimi sözleşmesi ayrıca revize edilir; platform sunucusuna kimlik bilgisi gönderilmez.
- [Lean — Validating a Lean Proof](https://lean-lang.org/doc/reference/latest/ValidatingProofs/): Transitif axiom denetimi, güvenilir challenge, ispatın yeniden kontrolü ve kötü niyetli kod için `comparator`/bağımsız checker yaklaşımı.
