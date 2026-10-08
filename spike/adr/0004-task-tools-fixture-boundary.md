# ADR 0004 — Task-tools sandbox sınırının canlı fixture denemesi

2026-10-08 · Durum: **Windows host + Docker Linux/WSL2 fixture kanıtı uygulandı. Tam CLI/auth fizibilite kararı bekliyor.**

## Karar

Kişisel hesap kullanılmadan önce görev araç ortamını gerçek engine üzerinde sınayacağız. İç `TaskToolsRuntime` yalnız F0 fixture başlatıcısına bağlıdır; UI/API çalıştırma yoluna veya production adaptörüne bağlanmaz. Resmi Node 22 imajı manifest digest'iyle sabitlenir. Her attempt kendi opaque volume'ünü ve non-root, network-off, read-only/capability/seccomp/cgroup sınırlı konteynerini alır.

Başlatıcı host shell üzerinden görev çalıştırmaz; Docker argv kullanır. Timeout/iptal/çıktı taşması tüm owned task konteynerini kaldırır. Cleanup yalnız generated isim ve owner etiketiyle yapılır; daemon erişim hatası cleanup başarısı sayılmaz. Ürün kullanıcısının diğer Docker kaynakları silinmez.

## Kanıt

`npm run spike:sandbox`: 12/12 canlı kontrol ve kaynak temizliği geçti. Canlı testte ayrı sahte auth fixture'ı ile task PID/filesystem sınırı, `/proc`/env, host path/traversal/symlink/socket, dış TCP, tmpfs/namespace, cgroup CPU/memory/PID, process exhaustion, fresh workspace ve detached child timeout/abort/output overflow sınandı. Resmi CLI/account/MCP bu testte yoktur.

İlk non-root yazma denemesi başarısız oldu: empty volume copy-up sahipliği root'a dönüştürdü. Init/task mount'larında `volume-nocopy` ile düzeltildi, canlı testler tekrar geçti. Son başarılı kayıt `spike/results/sandbox-windows-2026-10-08.json`; ilk başarısız ham kayıt `.local/sandbox` içinde korunur.

Native Windows Claude 2.1.293 help/version ve Docker 29.8.2 engine erişimi ayrıca doğrulandı. Stale process PATH sorunu native install konumunun read-only probe tarafından doğrudan kullanılmasıyla düzeltildi; global PATH değişmedi. Help flag'leri runtime araç izolasyonu kanıtı sayılmaz.

## Sonuç ve kalan işler

Bu kanıt A/B CLI kimlik modelini seçmez, SWE-ReX'i kabul etmez ve GO kapısını açmaz. Gerçek CLI/auth OS sınırı, tüm yerel/built-in/MCP/plugin/hook/subagent yolları, broker authorization, artifact path yarışları, token yenileme/logout, gerçek diff, sağlayıcı koşulları ve üç host platformu hâlâ doğrulanmalıdır. Broker/engine/host kesintisinden sonra cleanup/deadline uzlaştırması da production kabul işidir. Fixture timer tek başına crash recovery garantisi değildir.

Ubuntu fixture CI işi eklendi; yerel Windows/WSL2 başarısı uzak Linux host CI başarısı olarak sunulmaz. F0/v1 kapsamı korunur.
