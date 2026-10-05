# Aktualny model fizyki

Stan po poprawkach z 05.10.2026. Ten dokument zastępuje historyczny opis fizyki w `opis.md` i `opis.txt`.

## Jednostki i geometria

Świat używa metrów, sekund, kilogramów i radianów. Jedna jednostka współrzędnych odpowiada jednemu metrowi. Szerokość toru 14 m oznacza rzeczywistą szerokość geometrii 14 jednostek. Kamera odpowiada za skalowanie obrazu.

Fizyczny obrys samochodu wynosi 5,5 × 1,8 m. Kolizja z bandą sprawdza ruch obrysu, w tym ścieżki narożników oraz obrót pomiędzy pozycjami, z przestrzennym podziałem do 0,25 m i doprecyzowaniem momentu kontaktu. Powiększony symbol graficzny 9 × 3 jednostki służy czytelności i nie powiększa obrysu kolizji.

## Siły i integracja

- Masa: 798 kg plus bieżące paliwo; start domyślnie 105 kg, zbiornik 110 kg.
- Moc: do 750 kW, ograniczona trakcją tylnej osi. Pusty bak odcina moc, samochód może już tylko wytracać prędkość.
- Aerodynamika: gęstość 1,225 kg/m³, `Cd*A=1,00 m²`, `Cl*A=3,10 m²`. Opór przeciwdziała całemu wektorowi prędkości względem nieruchomego powietrza; docisk rośnie z kwadratem prędkości.
- Bazowe tarcie: 1,85, z mnożnikiem osiągów i uproszczoną korektą transferu bocznego.
- Obciążenia osi sumują się do ciężaru i docisku. Transfer wzdłużny korzysta z przyspieszenia poprzedniego kroku.
- Napęd, hamowanie i toczenie wykorzystują wspólny budżet siły wzdłużnej osi. Żądanie hamowania rozdzielane jest 56/44 i ograniczane osobno na osiach.
- Siła boczna każdej osi korzysta z pozostałego koła tarcia `sqrt((mu*Fz)^2-Fx^2)`. Skręt i korekcja poślizgu są sumowane w tej samej osi i wspólnie ograniczane.
- Globalny wektor prędkości jest aktualizowany jeden raz z wynikowej siły. Zmiana orientacji nadwozia sama nie obraca pędu.
- Sterowanie ma odpowiedź pierwszego rzędu o stałej 0,05 s; prędkość kątowa jest ograniczana dostępną siłą boczną przy każdej prędkości. To nadal model hybrydowy, bez momentu bezwładności yaw i pełnego modelu sił zależnych od kątów poślizgu osi.
- Telemetria G jest podpisanym przyspieszeniem ze zmiany prędkości, rzutowanym na osie pojazdu z początku kroku. Nie jest obcinana przed wykorzystaniem w transferze mas.

Worker używa stałego kroku 1/60 s i akumulatora rzeczywistego czasu. Tryb Balanced 1× nie wykonuje dodatkowych kroków tylko dlatego, że ticker uruchamia się co 16 ms. Po pauzie nie nadrabia czasu zatrzymania. Długie opóźnienia ograniczane są do 0,25 s, a liczba kroków do budżetu profilu, aby uniknąć spirali nadrabiania. Profile Performance i Turbo celowo przyspieszają symulację; MAX wykorzystuje dostępny budżet.

## AI, paliwo i postój

Poprawka treningu z 05.10.2026: po ukończeniu pierwszego okrążenia rekordowa sieć zespołu jest nadpisywana tylko po poprawie czasu PB, a nie przy wzroście kumulowanego fitness. Automatyczne cykle generacji zachowują jadące bolidy z ukończonym okrążeniem, wraz z pozycją, prędkością, paliwem, aktywną siecią i bieżącym okrążeniem. Ręczna „Nowa Gen” nadal rozpoczyna jazdę ze startu, zachowując zapisane rekordowe modele. Po przywróceniu modelu z PB usuwane są próbki nieudanej próby z replay buffer. Profil prędkości lidera jest przypisywany do przestrzennie odpowiadających checkpointów.

AI śledzi krótką trajektorię wzdłuż osi toru zamiast celować o całe checkpointy naprzód przez wąskie zakręty. Sieć wnosi ograniczoną korektę skrętu. Progi sensorów zależą od szerokości drogi, a plan hamowania jest konserwatywną heurystyką, nie dokładnym solverem maksymalnego tempa.

Tankowanie ma przepływ 28 kg/s, cel 110 kg i czas co najmniej 3,2 s. Końcowy krok nalicza tylko pozostały czas tankowania. Postój wlicza się do czasu okrążenia i wyścigu. Początek postoju następuje przy zaliczeniu mety po zgłoszeniu zjazdu; brak fizycznego przejazdu aleją serwisową pozostaje uproszczeniem gry.

## Pobocza i bandy

Każdy tor generuje oddzielne krawędzie asfaltu, pas trawy, żwir i bandy. Bazowe pobocze na prostych wynosi 0,25 szerokości asfaltu na stronę (3,5 m przy torze 14 m). Trawa zajmuje do 0,08 szerokości toru. Pobocze zewnętrzne zakrętów jest projektowane na 1–4 szerokości toru na podstawie wygładzonej krzywizny i szacowanej prędkości dojazdu; rozszerzenie obejmuje wejście i wyjście. Poszerzanie ograniczono do 0,3 m na metr drogi. Sąsiedni asfalt może ograniczyć strefę poniżej docelowej szerokości. Przecinający się asfalt jest odrzucany przed wymianą bieżącego toru. Renderer, kamera i fizyka korzystają z jednej geometrii; JSON starszych torów pozostaje zgodny.

Nawierzchnia jest próbkowana pod czterema kołami (rozstaw osi 3,6 m, szerokość 1,8 m). Wypadkowe μ stanowi średnią udziałów: asfalt 1,85, trawa 0,45, żwir 0,60. Dodatkowy opór przeciwny do całego wektora prędkości wynosi 0,04 g na trawie i 0,35 g na żwirze przy pełnym udziale nawierzchni. Impuls nie może odwrócić ruchu. To parametry uproszczonego modelu, nie kalibracja konkretnego toru. Pełny postój w żwirze może uniemożliwić ponowne ruszenie.

Przekroczenie białej linii nie powoduje DNF. Po lekkim kontakcie z bandą usuwana jest prędkość skierowana w bandę, a pozostała mnożona przez 0,8; bolid jest odsuwany o 3 cm. Prędkość prostopadła do bandy co najmniej 12 m/s kończy jazdę. W wyścigu nie ma respawnu; trening przywraca auto po 0,5 s. Telemetria pokazuje nawierzchnię i przyczynę eliminacji. Odzyskiwanie kontroli dostaje do 30 s bez checkpointu, pozostała jazda zachowuje dotychczasowy limit 10 s.

## Pomyłki AI i ochrona uczenia

Ryzyko wynosi `clamp((wykorzystaniePrzyczepności − 0,55) / 0,45, 0, 1)`. Zdarzenia mają prawdopodobieństwo `1 − exp(−ryzyko * dt / 600)` w kroku czasu symulacji. Przy pełnym ryzyku daje to średnio jedną pomyłkę na 10 minut ekspozycji, z 30 s przerwy po zdarzeniu. Pomyłka trwa 0,2–0,6 s i zmniejsza hamowanie do 25% żądania albo zmienia skręt o 0,08–0,20. Nie wymusza wypadnięcia, nie zmienia wag sieci i nie dodaje sił. Pomyłki działają w treningu i wyścigu; nie działają podczas postoju, ręcznego sterowania, odzyskiwania kontroli lub po finiszu.

Podczas pomyłki i odzyskiwania kontroli replay jest wyłączony i czyszczony. Dotknięte zdarzeniem lub wyjazdem na pobocze okrążenie liczy się w dystansie i czasie wyścigu, ale nie zastępuje PB, sieci mistrza ani profilu prędkości lidera i nie uruchamia cofnięcia za pogorszenie czasu. Po wyjeździe AI korzysta z geometrycznego celu na asfalcie, ogranicza gaz i hamuje zależnie od prędkości. Checkpointy pozostają uporządkowane i wymagają przejazdu po asfalcie.

## Ograniczenia

Brak kontaktów samochód–samochód, pełnego modelu uszkodzeń, modelu zawieszenia, temperatury i zużycia opon, skrzyni biegów, wiatru i map aero. Model nie był kalibrowany względem danych konkretnego bolidu F1. Dawne czasy okrążeń i wagi AI nie są porównywalne z wynikami po zmianie fizyki oraz szerokości toru; zalecany jest nowy trening.

## Weryfikacja

`npm run test:learning` sprawdza ochronę modeli PB, odzyskiwanie po rozbiciu, ciągłość generacji, czyszczenie nieudanych próbek i mapowanie telemetrii lidera; zawiera test 400 sekund rzeczywistej pętli treningowej.

`npm run test:runoff` sprawdza generowanie i ograniczanie poboczy, nawierzchnie pod kołami, brak dodawania energii przez opór, lekkie i mocne zderzenia, szybkie przecięcie położenia bandy, powrót AI na asfalt, kolejność checkpointów i ochronę PB. Statystykę zdarzeń porównuje przy 30/60/120 krokach na sekundę; dodatkowo wykonuje trzy testy rzeczywistej jazdy po 600 sekund.

`npm test` uruchamia oba zestawy oraz sprawdza limity sił, hamowanie od spoczynku i w obu kierunkach, telemetrię, jazdę bokiem, brak paliwa, tankowanie i zegary, skalę, obrys oraz ukończenie okrążeń GP przez AI. Test workera z kontrolowanym zegarem sprawdza 1× przy tickerach 16 ms i 20 ms oraz pauzę. Dodatkowo sprawdza checkpointy pól startowych, ukończenie 10-okrążeniowego wyścigu przez AI, zamrożenie czasu po mecie i powrót do treningu. `npm run audit:physics` wypisuje wyniki numeryczne; `npm run build` sprawdza TypeScript i bundlowanie.

`AUDIT_PHYSICS.md` zachowuje dowody stanu sprzed napraw. Poprawiono osiem opisanych tam problemów i akumulator czasu; pełna dynamika yaw, kontakty między bolidami i fizyczna aleja serwisowa pozostają ograniczeniami modelu.

### Krótkie ataki na rywala

W wyścigu AI może podjąć próbę szybszego przejazdu, gdy rywal jedzie 2–35 m przed nim na tym samym odcinku, w zgodnym kierunku i na tym samym okrążeniu. Przy ciągłej okazji częstość rozpoczęcia wynosi średnio raz na 15 s czasu symulacji (p = 1 − exp(−dt/15)). Atak trwa 3–6 s, potem obowiązuje 20 s przerwy. Docelowa prędkość zakrętu rośnie o 4%, a szacowana zdolność hamowania o 8%, co opóźnia rozpoczęcie hamowania; rzeczywista moc i siły przyczepności nie zmieniają się. To założenia modelu, a nie statystyki prawdziwych kierowców.

Po utracie rywala, poślizgu, pomyłce, wyjeździe na pobocze lub zgłoszeniu pit stopu AI odpuszcza. Trening i ręczne sterowanie nie uruchamiają ataków. Telemetria pokazuje „ATAK: nazwisko”. Okrążenie liczy się w wyścigu, ale nie zastępuje rekordowej sieci ani wyników oceny modelu; próbki sterowania podczas ataku są wyłączone. Funkcja zmienia tempo jazdy; nie dodaje planowania manewru wyprzedzania ani kolizji między samochodami.

### Kontakt bolidów w wyścigu

Bolidy w wyścigu mają nieprzenikające prostokątne obrysy 5,5 × 1,8 m. Ciągły test osi rozdzielających wykrywa kontakt na całej drodze ruchu; obrót dzielony jest na małe odcinki. Lekkie uderzenie rozdziela auta i stosuje niesprężysty impuls zależny od ich mas. Składowa prędkości względnej skierowana w kontakt ≥ 8 m/s oznacza wypadek i DNF obu uczestników. Jest to uproszczony próg modelu. Uszkodzone auta pozostają przeszkodami. Telemetria podaje „WYPADEK Z INNYM BOLIDEM”. Zdarzenie wyklucza okrążenie z oceny sieci, ale czas wyścigu nadal liczy się normalnie.

AI ogranicza gaz i hamuje przed pojazdem w swoim korytarzu jazdy, uwzględniając odległość i prędkość zbliżania. Dotyczy to także dublowanych i zatrzymanych samochodów. Atak ustępuje hamowaniu bezpieczeństwa. Sterowanie ręczne nie jest korygowane, ale jego kolizje są fizyczne. W treningu niezależne próby modeli pozostają bez wzajemnych kolizji. Nie zaimplementowano jeszcze wyboru bocznej trajektorii wyprzedzania.

`npm run test:traffic` sprawdza najechanie od tyłu przy dużej prędkości, krzyżowanie trajektorii, lekkie kontakty, rozdzielenie obrysów, energię oraz hamowanie przed wolniejszym i zatrzymanym rywalem.
