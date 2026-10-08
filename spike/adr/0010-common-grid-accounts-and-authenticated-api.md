# ADR 0010 — CommonGrid hesabı ve kimlik doğrulamalı API

Tarih: 2026-10-08. Durum: F0 temeli; gerçek sağlayıcı/staging kabulü ayrı. Tam v1 kapsamı ve CLI izolasyon kapısı korunur.

## Karar

GitHub/Google platform girişi, katılımcının resmi Claude/Codex CLI abonelik girişinden ayrıdır. OAuth access/ID tokenları yalnız kimlik doğrulayan callback belleğinde kalır. Kalıcı kimlik `(provider, subject)` ile belirlenir; isim/e-posta otomatik bağlamaz. Migration 0005 mevcut domain tarihini değiştirmeden dış kimlik, tek kullanımlı browser-bound OAuth flow ve hash'i saklanan opaque session ekler.

Resmi sabit endpointler, S256 PKCE ve Google nonce/OIDC doğrulaması kullanılır. GitHub sayısal ID, JSON canonicalizer'ın float dönüşümünden önceki gövdeden int64 olarak okunur. OIDC multi-audience `azp`, response boyutu, duplicate key, redirect ve süre sınırları fixture'larla sınanır. DB outage geçersiz giriş gibi gösterilmez.

API kullanıcıyı HttpOnly çerezden alır. Host ve Origin tam yapılandırmadan doğrulanır; yazma ayrıca CSRF ister. Aynı hostname/scheme UI ve API, relative `/api` proxy ve HTTPS üretim çerezi kullanılır; geliştirmede açık loopback HTTP istisnası vardır. Üretim API startup salt okunur migration/hash kontrolü yapar. Eksik provider ayarı sahte login açmaz.

DB proje/görev katalogu ve kişisel katkı listeleri bağlanır. Mevcut lease stop/end, atomik sonuç/checkpoint receipt ve yetkili review metadata yazmaları domain kurallarını kullanır. `/end completed` kapalıdır; completion sonuçla atomik `/result` üzerinden yapılır. HTTP verifier verdict/grant veremez. Reserve/start uçları izolasyon gate'i geçene kadar her zaman kapalıdır.

Türkçe/İngilizce hesap ve katkı ekranı, provider readiness, hata/expiry ve başarılı/başarısız logout ayrımı sunar. CSRF yalnız bellekte; private katalog/receipt ekranları çıkış/expiry'de temizlenir. Giriş tek başına AI görevi başlatmayı açmaz.

## Kanıt ve kalan işler

Tekrar: `npm run test:db`, `npm run test:ui`, `npm run check`, `node scripts/go.mjs vet ./...`. PostgreSQL gerçek; provider cevapları ve browser hesap senaryoları yerel fixture'dır. Kimlik/flow/session yarışı, rotation/replay/expiry, HTTP sahiplik/CSRF, checkpoint/result/review zinciri ve özel verinin temizlenmesi sınanır. Son public raporlar `spike/results`, ham denemeler `.local` altında tutulur.

Son kaynakta PostgreSQL/HTTP paketinde **77 adlandırılmış kontrol** (alt testler ve saf guards dahil), sıfır failure/skip; tarayıcıda **12 test**, genel kontrolde **169 Node testi**, Go testleri/vet ve frontend/Go build geçti. Raporlar `account-api-postgres-windows-2026-10-08.json`, `account-api-foundations-windows-2026-10-08.json`, `account-ui-windows-2026-10-08.json`. Yeni gövde/credential/origin kontrolleri ve startup config sonrasında Go paketi ayrıca `-count=1` ile test sonucu önbelleği kullanılmadan tekrar çalıştırıldı. Test verisi hex hash'i ve UI test-loader sorunu ilk koşudan sonra düzeltildi; ara başarısız kayıtlar korunur.

Gerçek OAuth uygulama kayıtları/client secret ve staging HTTPS callback kabulü yapılmadı. Native paket auth dönüşü, gerçek artifact deposu/importer/scanner/verifier, review workspace, puan/merge, production auth retention/rate-limit/rol ayrımı, workflow ve CLI izolasyon kabulü ayrı kalır. Yeni model/account çağrısı veya Docker gerçek oturumu kullanılmadı. Kurulum ve kaynaklar `docs/AUTHENTICATION.md` içindedir.
