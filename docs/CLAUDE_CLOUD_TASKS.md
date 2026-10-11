# Claude bulut geliştirme görevleri

Bu görevler mevcut main dalındaki Windows/Codex görev akışını tamamlayan ürün işleridir. Gerçek Windows/WebView2, resmi Claude girişi ve Haiku görev kabulü yerelde yürütülür. Bulutta model çağırmadan geliştirilebilecek dört iş seçildi.

Claude'a aşağıdaki ortak talimatı ve seçtiğin görevi birlikte verebilirsin. Önce görev 1'i öneriyorum; sonra görev 2. Görev 3 ayrı dosyalarda paralel geliştirilebilir. Görev 4 kendi çekirdeğinde bağımsızdır; milestone ölçümüyle entegrasyonu görev 3'ten sonra yapılır.

## Ortak teslim talimatı

```text
CommonGrid reposunun güncel main dalını başlangıç al. Eski claude/optimistic-cannon-voq9kh dalını başlangıç alma; onun değişiklikleri ve yerel düzeltmeler main'e geçti.

AGENTS.md, docs/DEVELOPMENT.md ve verilen görevin ilgili mevcut kodlarını oku. Ürün hedefi MVP'nin ötesinde tamamlanmış v1; bu teslim onun bir parçasıdır. Yalnız verilen işi yap, mevcut özellikleri yeniden yazma.

Bulutun geliştirme dalında çalış. Windows native-worker, src-tauri, CLI/auth, Docker sahipliği ve gerçek görev çalıştırma protokollerini bu görevlerde değiştirme. Gerçek AI çağrısı veya API fallback yapma; fixture ve mock kullan. Gerçek hesap girişleri, yerel kabul ve birleştirme ayrıca yapılacak.

Yeni bir endpoint, veritabanı tablosu veya bağımlılık gerekiyorsa önce mevcut olanın neden yeterli olmadığını somutlaştır; bunları verilen işi büyütmenin varsayılan yolu yapma. Şemadan üretilen dosyaları elle değiştirme. Var olan görev sözleşmesi/hash ve yetki sınırlarını koru.

İlgili birim/UI testlerini, typecheck ve gerekiyorsa derlemeyi çalıştır. Ortamda çalışmayan kontrolü nedeni ile bildir; fixture sonucu gerçek Docker, Windows veya hesap kabulü sayılmaz. Geçmiş test kayıtlarını değiştirme. Auth, ham log, .local ve .tools dosyalarını commit etme.

Kontrolleri geçen her tamamlanmış adımı anlamlı commit ile teslim et. Çalışma dalını GitHub'a push et; sonunda dal adı, commit, değişen davranış, çalıştırılan testler ve yerelde bekleyen kontrolleri kısa yaz. Main'e birleştirme yapma. Birden fazla görevi tek büyük değişiklikte toplama.
```

## Görev 1 — Katkı detayı ve kayıtlı ilerleme inceleme ekranı

```text
Katkılarım ekranındaki kayıtları açılabilir hale getir. AccountPanel zaten deneme, gönderim ve checkpoint listelerini/sayfalamasını gösteriyor; bu listeleri yeniden yazma.

Mevcut gerçek endpoint'leri kullan:
- GET /api/v1/leases/{id}
- GET /api/v1/submissions/{id}
- GET /api/v1/checkpoints/{id}
- GET /api/v1/tasks/{id}/resume?task_version=...&contract_hash=...&base_commit=...&strategy_id=...

Mevcut modelleri services/coordinator/internal/store/{budget,candidates,checkpoints}.go ve packages/task-schema/src/generated.ts üzerinden incele. Detay cevapları {item: ...} zarfındadır. accountJSON/AccountExpired davranışını yeniden kullan; 404/503 ayrımı için contribution-client içinde dar HTTP hata desteği gerekebilir. Deneme bütçesindeki reserved_ms/spent_ms/overrun_ms süre kapasitesidir, para/token/abonelik kotası diye gösterme.

Teslim et:
- Listeden tıklanarak açılan, klavyeyle kullanılabilen detay paneli.
- Denemenin stratejisi, durumu ve mevcut süre/bütçe bilgileri; gönderimin doğrulama durumu ve artifact kimliği/hash'i.
- Checkpoint özeti, devam talimatları, görev sürümü/sözleşme hash'i/base commit, parent, son kullanma tarihi ve doğrulama durumu. Veri yoksa açıkça bilinmiyor göster.
- Mevcut doğrulanmış görev ve seçilen onaylı stratejiyle sunucudan uyumlu son checkpoint'i salt okunur kontrol etme. Bunun hesap bilgisi veya doğrulanmış sonuçla uyuştuğunu istemci varsaymasın; sunucu cevabını göster.
- Türkçe/İngilizce metinler, yükleme/hata/boş durumları ve kapatınca odağın kayda dönmesi.

Bu işte checkpoint'ten gerçek görevi devam ettirme işlemi ekleme; bunun çalışma zamanı entegrasyonu ayrı. GET /artifacts/{id} yalnız makbuz döndürür: artifact içeriği/diff indirme veya bakımcı onayı varmış gibi gösterme.

Dosya sahipliği: apps/desktop/src/AccountPanel.tsx; yeni ContributionDetailPanel.tsx, contribution-client.ts ve gerekirse ayrı contribution-detail.css. App.tsx yalnız gerekli prop bağlantısı için küçük değişebilir. Görev 2'nin katalog dosyalarına dokunma.

Kabul: tests/ui/contribution-details.spec.ts içinde üç kayıt türü; submitted/verifying/usable/rejected checkpoint ve expires_at geçmiş kayıt; 404 uyumlu kayıt yok; 401'de hesap verisinin temizlenmesi; hesap/sekme/seçim değişince eski cevabın gösterilmemesi; HTML benzeri özetin düz metin kalması; hash/tarih doğrulama; klavye ve TR/EN testleri. Süre dolmasını expires_at üzerinden türet, olmayan expired checkpoint status'ü icat etme. Mevcut account UI testleri, typecheck ve masaüstü web derlemesi geçsin. Sunucu/migration/native bağımlılığı gerektirme.
```

## Görev 2 — Görev kataloğunda sayfalama, durum ve bağımlılık gezgini

```text
Mevcut katalog arama, tür/proje filtresi, sözleşme, milestone ve dosya manifesti görünümünü koruyarak gerçek API sayfalamasını ve görev ilişkilerini ekle.

useTaskCatalog şu anda tasks/projects cevaplarının next_cursor alanını ve canlı görev cevabındaki statuses haritasını kullanmıyor. TaskContract.depends_on, node_id ve kind alanlarını; services/coordinator/internal/httpapi/live.go içindeki liste/tek görev cevaplarını incele.

Teslim et:
- Kontrollü Daha fazla yükle akışı; proje ve görev cursor'larının ayrı yönetimi. Bounded istek/öğe sınırları, yinelenen cursor/kimlik ve geç gelen cevap kontrolü.
- Sunucudan gelen görev durumları için rozet ve filtre; fixture'da durum yoksa bilinmiyor göster. Durumu görev sözleşmesinin içine ekleyip hash'i değiştirme.
- Seçili görevin önkoşulları ve ona bağımlı görevleri arasında erişilebilir gezinme. Henüz yüklenmemiş veya filtre dışında kalan ilişki açık olsun. Basit liste/yerel SVG yeterli; yeni grafik kütüphanesi zorunlu değil.
- plan/solve/refute/rebase türlerini doğru etiketleme; plan dışındaki bütün türleri solve diye gösterme.
- TR/EN, yükleme, bağlantı hatası, boş sonuç ve küçük ekran davranışı.

Bu bir depends_on görünümüdür; tam AND/OR orkestratör ağacı değildir. Bağımlılık durumundan görev çalıştırma yetkisi üretme. Mevcut native Onaylı görev paneliyle katalog başlatma akışı ayrı kalır; katalogdaki çalıştırma sınırını bu görsel işte değiştirme.

Dosya sahipliği: apps/desktop/src/useTaskCatalog.ts, WorkspacePage.tsx, language.ts; yeni TaskDependenciesPanel.tsx, task-dependencies.ts ve ayrı task-dependencies.css. AccountPanel veya native protokollere dokunma.

Kabul: tests/ui/task-dependencies.spec.ts; ikinci sayfadaki önkoşul, filtre dışı ilişki, bilinmeyen durum, yinelenen cursor/kimlik, eski yenileme cevabı, 401/503, TR/EN ve 780px genişlik. TaskContract ve hash değişmeden kalsın; mevcut workspace testleri, typecheck ve web derlemesi geçsin. Yeni backend endpoint'i gerektirme.
```

## Görev 3 — Milestone ilerleme ve gerileme hesaplayıcısı

```text
PROJECT_SPEC1.2.md §11.2 için saf Go hesaplama çekirdeği geliştir. Milestone tanımı ve ağırlık doğrulaması zaten var; generic review/lease/checkpoint sistemi de var. Eksik olan ölçüm ve gerileme hesabını ekle.

Dosya sahipliği: yeni services/coordinator/internal/progress/{evaluate.go,evaluate_test.go,testdata/*} ve kısa docs/MILESTONE_PROGRESS.md. Mevcut ortak şema/generated dosyaları, DB, API ve native runtime değişmesin.

Girdi: mevcut contract.TaskContract, güvenilir checker tarafından üretilmiş aynı görev sürümü/hash/base/artifact bağlamına ait sonuçlar ve isteğe bağlı önceki ölçüm. Model beyanı veya istemci verisi doğrulanmış ilerleme olmasın. Hesaplayıcı bağlam tutarlılığını denetler; checker kimliğini doğrulamaz veya girdiye sunucu yetkisi kazandırmaz. Önceki ölçüm farklı artifact'tan gelebilir; aynı görev sözleşmesinde karşılaştırılsın ve artifact bağlamları ayrı korunsun.

Çıktı: sözleşmedeki sırayla milestone durumları, geçen ağırlık toplamı, gösterilecek ilerleme, kritik engeller, kazanılan/kaybedilen milestone kimlikleri, eksik/sınırlı ölçüm bilgisi.

Kurallar:
- Tanımlı ağırlıkları yeniden normalize etme. Çözülmemiş kritik milestone varsa gösterilen ilerleme en fazla 0.5.
- blocked geçiş sayılmaz; Lean bağımlılık kanıtını bu hesaplayıcı üretmesin, checker'ın sonucunu işlesin.
- Bilinmeyen/tekrarlı milestone, geçersiz durum veya bağlam uyuşmazlığını reddet.
- pass'ten geçmeyen duruma dönüş gerileme olarak raporlansın.
- Boş milestone tanımını tamamlanmış görev veya yüzde yüz başarı diye yorumlama.

Kabul: yüzde 80 ağırlık geçse de kritik başarısızken yüzde 50 gösterme; kritik geçince sınırın kalkması; pass→blocked gerilemesi; sahte milestone reddi; sürüm/hash/base uyuşmazlığı; önceki artifact'tan doğru gerileme hesabı; boş tanım ve giriş permütasyonları. node scripts/go.mjs test ./internal/progress geçsin. Hesaplayıcı shell, ağ veya model çağırmasın. Gerçek ölçüm harness'i, kalıcılık, API/UI ve puan dağıtımı bu teslimde tamamlandı denmesin.
```

## Görev 4 — Seed'li çevrimdışı orkestratör simülatörü

```text
Yol haritası Faz 5a için ilk kullanılabilir simülatörü geliştir. Amaç aynı problem/gönüllü/bütçe senaryosunda farklı zamanlama politikalarını karşılaştırmak; gerçek CLI veya production scheduler çalıştırmak değil.

Dosya sahipliği: yeni services/coordinator/internal/simulation/**, services/coordinator/cmd/simulate/** ve kısa docs/SIMULATOR.md. Önceki görevlerin dosyalarını, store/API/native/adapters kodunu değiştirme.

Mevcut task contract'larını contract.Validator ile doğrulayıp senaryoda kullan. Simülasyona özel AND/OR ilişkileri ve sentetik sonuçlar ayrı sürümlü senaryo verisinde bulunsun; bunları canlı task şemasına gizlice ekleme.

İlk teslim: seed, sanal olay zamanı, toplam ajan-zaman bütçesi, gönüllü kapasite/ayrılma, sentetik deneme süresi/başarısı ve handoff. Tek ajan, sabit paralellik, round-robin ve en az denenmiş önce politikalarını aynı girdide karşılaştır. Rastgele olayların politikadan bağımsız tekrar üretilebilirliğini koru; yalnız aynı seed kullanıp farklı sırada rastgele sayı tüketmek adil karşılaştırma sayılmaz.

Küçük fixture senaryoları: kolay OR, tüm çocukları gereken AND, tuzak dal, ortak profil başarısızlığı, yinelenen artifact, sağlayıcı kesintisi ve doğrulama/inceleme kuyruğu. Milestone ölçümü entegrasyonu görev 3 birleştikten sonra ayrı adım olabilir.

JSON raporu: seed/senaryo/politika/bütçe, örneklem sayısı ve çözüm oranı, çözülen görev başına ajan-saat ve duvar süresi, başarısız denemeler, kuyruk beklemesi, ortak hata/tekrar sayıları. Ölçülmeyen alan not_measured olsun; sıfır uydurma. Çözümsüz koşuları rapordan çıkarma. Gerçek model başarı/verimliliği veya ürün kabulü sonucu çıkarma.

Kabul: aynı girdi/seed ile aynı JSON; AND'in tek çocukla çözülmemesi; bütçenin aşılmaması; handoff sırasında çift compute olmaması; yinelenen artifact'ın iki yararlı sonuç sayılmaması; politikalara aynı problem/bütçe verilmesi; çözümsüz koşuda doğru oran ve boş değerler. node scripts/go.mjs test ./internal/simulation ./cmd/simulate ve küçük fixture CLI koşusu geçsin. Gerçek sleep, Docker, auth, model, Temporal veya Kubernetes gerektirmesin.
```

Görev 1 ve 2 mevcut backend'i kullanıcıya açar; görev 3 ve 4 ilerleme ölçümü ve topluluk zamanlaması için hesaplama çekirdeği sağlar. Canlı dosya editörü/terminali için çalışma alanı ve PTY taşıma sözleşmesi henüz yok; yalnız görsel ekranla tam IDE teslimi iddia edilmemeli.
