# CommonGrid geliştirme ve AI test tercihleri

- Ana ajan orkestrasyonu yürütür. Geliştirme alt ajanları `gpt-6.1-sol`, `high` kullanır; ana ajan dahil en fazla dört ajan eşzamanlı çalışır.
- Uygulamanın resmi CLI ile yanıt/görev üretebildiğini sınayan gerçek AI testlerinde Codex için `gpt-6-luna`, Claude için `haiku` kullanılır. Bu tercih geliştirme ajanlarının modelini değiştirmez; ürün kullanıcısının normal görev model seçimini de sınırlandırmaz.
- İşlev testinde ucuz model kullanılamıyorsa dur ve bildir; Astra/Sonnet/Opus veya hesabın varsayılan modeline kendiliğinden geçme. Ücretli API fallback başlatma.
- Model çağrısı gerektirmeyen kontrollerde yerel fixture/mock kullan. Kota tükenmesi için kullanıcının aboneliğini kasıtlı tüketme; hatayı önce fixture ile sınayarak gerçek davranışı normal kullanımda gözlemle.
- Tarihli pahalı model test raporları geçmiş kanıttır; yeni test tercihini yansıtmak için geçmiş sonuçların model alanını değiştirme.
- Her tamamlanmış ve ilgili kontrolleri geçmiş iş adımından sonra yerel, anlamlı bir commit oluştur. İlgisiz kullanıcı değişikliklerini commit'e katma; gizli bilgi, auth verisi, .local/.tools ve ham logları takip etme. Başarısız veya yarım işi tamamlanmış gibi commit etme. Kullanıcı istemedikçe remote'a push yapma.
