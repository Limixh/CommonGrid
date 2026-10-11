# ADR 0020: Uygulama içinde onaylı görev çalıştırma

Durum: Uygulanıyor — sözleşme, fixture ve mock testleriyle; gerçek hesap/Windows kabulü yapılmadı.

## Karar

İlk uygulama içi görev akışı, kabul edilmiş dar kapsamla açılır: tek kontrollü görev (`controlled-sum-integers-v1`, `sum.mjs` düzeltmesi), seçili ve hesabı bağlanmış profil, işlev testi modeli (Codex `gpt-6-luna`, Claude `haiku`). Arayüz yalnız istek kimliği, profil kimliği, sabit görev kimliği ve açık `approved: true` gönderir; prompt, model, komut, dosya yolu veya çalışma dizini seçemez. Ucuz model kullanılamıyorsa çalışma `model_unavailable` ile durur; pahalı/varsayılan modele veya ücretli API'ye geçilmez.

Akış: profil seçimi → hesap durumu → görev onayı → Başlat → `preparing` / `running` (araç çağrısı sayısı, gözlenen model) / `verifying` / `cleaning` → `finished`. Sonuç ancak bağımsız doğrulayıcı 34 örnekte geçtiğinde `passed` olur ve sınırlı unified diff ile hash'leri taşır. Doğrulayıcı reddi `rejected/candidate_rejected` olur ve diff göstermez. Cleanup doğrulanamazsa sonuç `needs_review/unknown` kalır ve aynı native süreçte yeni başlangıç engellenir.

Tarayıcı sözleşmesi `packages/agent-adapters/src/task-run-protocol.ts` içindedir (`@commongrid/agent-adapters/task-run`). Worker ile native arasındaki boot ve satır çerçeveleri aynı dosyada tanımlanır. Native taraf revision, iptal, süre sınırı ve public projection sahibidir; worker çıktısı yalnız bu çerçevelerle kabul edilir. Ham sağlayıcı çıktısı, hesap kimliği ve host yolları IPC'ye taşınmaz.

## Yeniden kullanılan parçalar

`spike/cli-session/managed-task.mts` ve `coding-task.mts` içindeki kabul edilmiş akış ürün paketine taşınır; spike ince uyarlayıcı olarak kalır. Profil eşlemesi, `ManagedCliRuntime`, görev araçları sandbox'ı, işlem claim'i ve faz günlüğü değişmeden kullanılır. Yeni genel altyapı katmanı eklenmez.

## Kabul sınırı

Bu ADR'deki testler sentetik worker bağımlılıkları, Rust süreç testleri ve browser native mock'larıdır; gerçek model çağrısı yapmaz. Gerçek hesapla uygulama içi görev, Windows/WebView2 koşusu, Claude'un uygulamadan girişi, doğal kota tükenmesi ve otomatik recovery ayrı kanıt gerektirir. Genel GO durumu değişmez.
