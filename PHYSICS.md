# Aktualny model fizyki

Stan po poprawkach z 05.10.2026. Ten dokument zastępuje historyczny opis fizyki w `docs/archive/opis.md` i `docs/archive/opis.txt`.

## Jednostki i geometria

Świat używa metrów, sekund, kilogramów i radianów. Jedna jednostka współrzędnych odpowiada jednemu metrowi. Szerokość toru 14 m oznacza rzeczywistą szerokość geometrii 14 jednostek. Kamera odpowiada za skalowanie obrazu.

Fizyczny obrys samochodu wynosi 5,5 × 1,8 m. Kolizja z bandą sprawdza ruch obrysu, w tym ścieżki narożników oraz obrót pomiędzy pozycjami, z przestrzennym podziałem do 0,25 m i doprecyzowaniem momentu kontaktu. Powiększony symbol graficzny 9 × 3 jednostki służy czytelności i nie powiększa obrysu kolizji.

### Rozdzielczość toru: punkty co 1 m (24.10.2026)

Każdy tor (GP, owal, rysowany, wczytany z pliku i 39 prawdziwych torów) jest próbkowany co `TRACK_POINT_SPACING` = 1 m (`src/math/Spline.ts`), a nie co 18–20 m. Wcześniej krawędzie asfaltu, krawężniki, bandy i kolizje były wielokątem o bokach 18 m. W nawrocie o promieniu 15 m jeden bok skręcał o ok. 70°, a cięciwa odchodziła od łuku o ok. 2,7 m. Teraz to odchylenie wynosi ok. 8 mm. Splajn jest próbkowany co 0,1 m przed przepróbkowaniem po długości łuku, więc punkty leżą na krzywej. Obraz i fizyka mają ten sam gładki kształt.

- Bramki (checkpointy) zostają co ok. 18 m (`Track.GATE_SPACING`) jako podzbiór punktów. Postęp okrążenia, nagroda fitness, sektory i zaliczanie bramek działają jak dotąd. `track.gateIndexOf(punkt)` zamienia punkt toru na bramkę.
- Wszystkie okna liczone dawniej w punktach są w metrach. Wygładzona krzywizna (`smoothedCurvature`, dwa filtry pudełkowe po 54 m, jak dawne wagi 1-2-3-2-1) obsługuje pobocza, marginesy linii jazdy, podgląd drogi w `LineNet` i `LineSearch` oraz kamery TV. Krzywizna lokalna (`localCurvature`, ok. 18 m) obsługuje krawężniki i krzywiznę bramek. Pobocze reaguje na zakręt 54 m przed nim i po nim, a za sąsiedni odcinek uznaje się wszystko w promieniu 45 m wzdłuż toru.
- Planer hamowania czyta linię co 3 m (`Car.PLAN_SAMPLE_SPACING`) na odcinku 144–432 m, zależnym od prędkości. Cel kierowania liczy od najbliższego odcinka osi.
- Linia jazdy jest rozwiązywana na siatce 18 m, a od 24.10.2026 także na pośrednim poziomie 9 m (1500 przebiegów). Na każdy punkt trafia przez splajn Catmull-Rom i 100 przebiegów wygładzania w pełnej rozdzielczości (zmiany z 24.10.2026: patrz „Ciasne zakręty” niżej). Krzywizna linii i profilu jazdy (`LineProfile`) jest liczona z łuków o podstawie 6 m. `LineProfile` zapisuje każdy mijany punkt (położenie boczne interpolowane między krokami).
- Siatka przestrzenna ma komórki 8 m. Promienie LiDAR przechodzą komórki wzdłuż promienia (DDA), a nawierzchnia szuka najbliższego odcinka osi pierścieniami komórek. Sprawdzanie przecięć asfaltu i pobocza korzysta z siatki zamiast porównywać każdy odcinek z każdym. Tor buduje się w 15–40 ms, a linia jazdy w ok. 100 ms.
- Skutek: zakręty mają prawdziwy promień splajnu. Dawny wielobok je łagodził: na GP największa krzywizna osi to 0,050 zamiast 0,038, a w pierwszym zakręcie 0,033 zamiast 0,020. Ekspert jedzie GP w ok. 58 s zamiast ok. 55 s (`diag-line-follow`). W treningu (180 s, ziarna 1–4) najlepsze okrążenie GP to 56,8–64,2 s zamiast 53,5–53,8 s. Na prawdziwych torach jest mniej rozbić na kanciastych krawędziach: w Monako 15–19 → 1–3 DNF, a najlepsze okrążenie 150–160 s (w dwóch ziarnach bez czasu) → 107–118 s; na Monzy 4–10 → 4–16 DNF i 103–147 s → 109–128 s.
- Prawdziwe tory wygenerowano od nowa (`scripts/build-tracks.mjs`). Najciaśniejszy promień jest teraz mierzony na punktach co 1 m, więc builder wybiera krok punktów kontrolnych, który nie robi nawrotów ciaśniejszych niż splajn. Szerokości i kierunki się nie zmieniły. Najciaśniejszy promień wzrósł np. w Bahrajnie z 5,4 do 8,7 m, na Imoli z 6,9 do 11,7 m, w Montrealu z 6,6 do 9,3 m. `npm run test:tracks`: wszystkie 39 torów bez problemów, 100% toru przejechane. Pokrycie toru liczone jest po bramkach.
- `npm run bench:step -- 60`: 533 → 591 µs na krok.

### Ciasne zakręty: geometria prawdziwych torów i linia jazdy (24.10.2026)

Na prawdziwych torach bolid zwalniał w wierzchołku do 28–45 km/h (Monako 22 km/h), w rzeczywistości ok. 45–50 km/h w Monako i ok. 60–80 km/h w typowym nawrocie. Pomiar `npm run diag:corners -- --tracks` (ekspert, ziarno 1, najwolniejszy punkt drugiego okrążenia) wskazał dwie przyczyny:

- Źródło (`scripts/data/f1-circuits.geojson`) rysuje zakręt dwoma–trzema wierzchołkami (94–171 na okrążenie). Splajn Catmull-Rom przechodzi przez nie i zostawia w wierzchołku załamanie o promieniu kilku metrów (Austin 6,1 m, Monza 8,0 m, Monako 3,8 m), a 10–20 m dalej promień ma już 30–50 m. Bolid nie skręci ciaśniej niż ok. 8,5 m (rozstaw osi 3,6 m, skręt kół 0,40 rad), więc jechał tam na pełnym skręcie i ślizgał się przy ok. 0,8 g. Zaokrąglenie samego pliku nie wystarczało, bo `Spline` odrzucał punkty bliższe niż 18 m. Plik nie mógł więc opisać łuku ciaśniejszego niż ok. 20 m bez nowego załamania, a zwykłe wygładzanie ściągało nawroty (Montreal o 128 m).
- Linia jazdy była w takich miejscach ciaśniejsza od osi (Austin 3,5 m, Szanghaj 3,6 m). Suma kwadratów krzywizny toleruje krótki, bardzo ciasny łuk w zamian za łagodniejsze obok, a prędkość w zakręcie wyznacza najciaśniejszy łuk. Poziomy siatki brały punkty co `stride`, więc ostatni odcinek pętli był dłuższy (na GP przy siatce 9 m 17 m zamiast 9 m), a interpolacja między poziomami przypisywała w nim wartości złym punktom.

Zmiany:

- `build-tracks.mjs`: łamana źródła próbkowana co 25 m przechodzi trzy przebiegi Chaikina (odcinanie wierzchołków, granica to gładki B-splajn). Punkty są zapisywane co ok. 3,1 m, z dokładnością 0,01 m: zaokrąglenie do 0,1 m dawało przy tej gęstości widoczne tętnienie krzywizny. Oś odchodzi od źródła o 2,7–8,8 m (zwykle 3–7 m, w granicach dokładności źródła), długość jest nadal dopasowywana do oficjalnej (0,2%).
- Pole `pointSpacing` w pliku toru (m między punktami). `Spline.generateClosedTrack` ma parametr `minPointGap`: plik z tym polem zachowuje punkty odległe o ćwierć `pointSpacing` (`pointGapFor`), a rysowanie myszą, presety i stare pliki bez pola zostają przy 18 m (`DRAWN_POINT_GAP`). Strona przekazuje odstęp do workera razem z punktami (`setCustomTrack`, `setTrackWidth`), a eksport toru go zapisuje.
- `RacingLine`: poziomy siatki są rozłożone równo na całej pętli (`round(k·n/m)`), a interpolacja z poziomu do poziomu liczy się na rzeczywistych pozycjach punktów. Doszedł poziom pośredni 9 m (`MID_LEVELS`; poziom 3 m dodatkowo otwierał nawroty, ale na Monzy trzymał linię z dala od wierzchołka szerszego zakrętu, `test-lines`). Po pierwszym rozwiązaniu jest drugie, z wagą punktu `max(1, (κ·30 m)²)` od najciaśniejszej krzywizny linii w promieniu 10 m (`PEAK_RADIUS`, `PEAK_REACH`, maks. 50). Otwiera to łuki ciaśniejsze niż 30 m, a szersze zakręty zostają bez zmian.

Skutki (ekspert, przed → po):

- Najciaśniejszy promień osi: Austin 6,1 → 10,4 m, Monza 8,0 → 14,3 m, Bahrajn 8,7 → 14,3 m, Monako 3,8 → 6,2 m. Linia jazdy ciaśniejsza niż 9 m: 17 → 4 torów (Monako 4,7 m, Hockenheim, Magny-Cours i Szanghaj ok. 8–8,4 m przy osi ok. 10,5 m).
- Minimalna prędkość: mediana 38 → 57 km/h, najniższa 22 → 26 km/h (Monako: nawrót w źródle jest ciaśniejszy niż skręt bolidu). Np. Monza 35 → 59 km/h, Austin 29 → 41 km/h.
- Okrążenie (34 tory, które przed zmianą kończyły dwa okrążenia w 300 s): średnio −6,6% (od −12,3% do +0,9%). GP (`diag:corners`, 6 ziaren): 55,88 → 54,27 s. Trening GP (`diag:nn -- 600`, ziarna 1–3): średni najlepszy czas 58,13 → 57,25 s.
- `npm run test:tracks -- 6`: wszystkie 38 torów bez problemów, 100% toru przejechane.
- Linia liczy się dłużej: trzy style na GP ok. 105 ms zamiast ok. 31 ms, na prawdziwym torze ok. 0,2 s na styl (raz na tor, w workerze i dla rysowanej linii na stronie). `bench:step` mierzy to razem z jazdą (595 → 634 µs na krok, w tym poprawka wraków +2%). Sam krok fizyki nie zwolnił.

## Siły i integracja

- Masa: 798 kg plus bieżące paliwo; start domyślnie 105 kg, zbiornik 110 kg.
- Moc: do 750 kW, ograniczona trakcją tylnej osi. Pusty bak odcina moc, samochód może już tylko wytracać prędkość.
- Aerodynamika: gęstość 1,225 kg/m³, `Cd*A=1,00 m²`, `Cl*A=3,10 m²`. Opór przeciwdziała całemu wektorowi prędkości względem nieruchomego powietrza; docisk rośnie z kwadratem prędkości.
- Bazowe tarcie: 1,85, z mnożnikiem osiągów i wrażliwością opon na obciążenie przy transferze bocznym (sekcja „Wrażliwość opon na obciążenie”).
- Obciążenia osi sumują się do ciężaru i docisku. Transfer wzdłużny korzysta z przyspieszenia poprzedniego kroku.
- Napęd, hamowanie i toczenie wykorzystują wspólny budżet siły wzdłużnej osi. Żądanie hamowania rozdzielane jest 56/44 i ograniczane osobno na osiach.
- Siła boczna każdej osi korzysta z pozostałego koła tarcia `sqrt((mu*Fz)^2-Fx^2)`. Skręt i korekcja poślizgu są sumowane w tej samej osi i wspólnie ograniczane.
- Globalny wektor prędkości jest aktualizowany jeden raz z wynikowej siły. Zmiana orientacji nadwozia sama nie obraca pędu.
- Powyżej ok. 8 m/s działa dynamiczny model jednośladu (patrz „Dynamika poślizgu”); poniżej — kinematyczna odpowiedź pierwszego rzędu (0,05 s), ograniczona dostępną siłą boczną. Przejście jest płynne (8–16 m/s).
- Telemetria G jest podpisanym przyspieszeniem ze zmiany prędkości, rzutowanym na osie pojazdu z początku kroku. Nie jest obcinana przed wykorzystaniem w transferze mas.

Worker używa stałego kroku 1/60 s i akumulatora rzeczywistego czasu. Tryb Balanced 1× nie wykonuje dodatkowych kroków tylko dlatego, że ticker uruchamia się co 16 ms. Po pauzie nie nadrabia czasu zatrzymania. Długie opóźnienia ograniczane są do 0,25 s, a liczba kroków do budżetu profilu, aby uniknąć spirali nadrabiania. Profile Performance i Turbo celowo przyspieszają symulację; MAX wykorzystuje dostępny budżet.

## AI, paliwo i postój

Poprawka treningu z 05.10.2026: po ukończeniu pierwszego okrążenia rekordowa sieć zespołu jest nadpisywana tylko po poprawie czasu PB, a nie przy wzroście kumulowanego fitness. Automatyczne cykle generacji zachowują jadące bolidy z ukończonym okrążeniem, wraz z pozycją, prędkością, paliwem, aktywną siecią i bieżącym okrążeniem. Ręczna „Nowa Gen” nadal rozpoczyna jazdę ze startu, zachowując zapisane rekordowe modele. Po przywróceniu modelu z PB usuwane są próbki nieudanej próby z replay buffer. Profil prędkości lidera jest przypisywany do przestrzennie odpowiadających checkpointów.

AI śledzi krótką trajektorię wzdłuż osi toru zamiast celować o całe checkpointy naprzód przez wąskie zakręty. Sterowanie wykonuje sieć neuronowa (szczegóły w sekcji „Sieć neuronowa jako kierowca”). Progi sensorów zależą od szerokości drogi. Wolne miejsce przed autem (`minCenterClearance`) to odległość z trzech środkowych promieni podzielona przez szerokość toru, w skali `Car.CLEARANCE_REF_WIDTH = 76`. Progi `CLEAR_FULL` 0,22 (pełny gaz), `CLEAR_LIFT` 0,12 (poniżej: hamowanie awaryjne i strażnik) i `CLEAR_CAP` 0,2 odpowiadają ok. 0,69 / 0,38 / 0,63 szerokości toru. Szerszy tor widzi bandę w zakręcie dalej, dlatego progi nie są stałymi w metrach. Plan hamowania jest konserwatywną heurystyką, nie dokładnym solverem maksymalnego tempa.

Zużycie paliwa wynika z mocy silnika: `FUEL_FLOW_MAX · gaz · f(obroty)` plus 0,0006 kg/s na biegu jałowym, gdzie `FUEL_FLOW_MAX` = 100 kg/h (limit przepływu z regulaminu), a `f` to krzywa mocy ICE. Daje to ok. 0,32–0,33 kg/km (GP: ok. 0,94 kg/okr., Spielberg ok. 1,37 kg/okr.), czyli ok. 100 kg na 300 km wyścigu.

Postoje (`src/physics/PitStrategy.ts`) działają tak samo w treningu, kwalifikacjach i wyścigu. Nikt nie tankuje. Od 25.10.2026 auto przejeżdża prawdziwą aleją serwisową (patrz „Aleja serwisowa” niżej). Dostaje nowy komplet opon i naprawione uszkodzenia. Postój wlicza się do czasu okrążenia i wyścigu. Okrążenie wyjazdowe nie jest okrążeniem wzorcowym (nie ustala rekordu ani nie ocenia modelu).

Strategia AI: zjazd przy zużyciu opon > 70% (nie na ostatnich dwóch okrążeniach wyścigu), zjazd w dowolnym momencie, gdy opony nie pasują do warunków, a w wyścigu na suchym obowiązek użycia dwóch mieszanek slick. Jeśli auto do połowy dystansu nie zmieniło mieszanki, zjeżdża wtedy. Zasada nie obowiązuje, jeśli użyto opon przejściowych lub deszczowych. Gracz decyduje o postojach sam (klawisz P).

Paliwo na wyścig: liczba okrążeń × zużycie na okrążenie stawki na tym torze (średnia z ukończonych okrążeń treningu, a bez nich 0,35 kg/km) + 4% + 1,5 kg rezerwy. Jeśli bak (110 kg) nie wystarcza na zadany dystans, wyścig jest skracany do liczby okrążeń, którą da się przejechać, jak limit dystansu w F1. Licznik okrążeń pokazuje rzeczywisty dystans. Stałe i plan paliwa są w `src/race/RaceFuel.ts`, wspólne dla wyścigu i treningu. W treningu auto startuje sesję z ustawionym paliwem startowym, a przy każdym respawnie dostaje losowe paliwo z zakresu wyścigowego: od 5 kg (końcówka wyścigu) do paliwa na 50 okrążeń, więc sieć poznaje każdą masę auta, jaką spotka w wyścigu. Auto bez paliwa odpada (wrak jak po wypadku) i wraca z nowym losowym paliwem. Przycisk „Tankuj” działa tylko w treningu.

## Pobocza i bandy

Każdy tor generuje oddzielne krawędzie asfaltu, pas trawy, żwir i bandy. Bazowe pobocze na prostych wynosi 0,25 szerokości asfaltu na stronę (3,5 m przy torze 14 m). Trawa zajmuje do 0,08 szerokości toru. Pobocze zewnętrzne zakrętów jest projektowane na 1–4 szerokości toru na podstawie wygładzonej krzywizny i szacowanej prędkości dojazdu; rozszerzenie obejmuje wejście i wyjście. Poszerzanie ograniczono do 0,3 m na metr drogi. Sąsiedni asfalt może ograniczyć strefę poniżej docelowej szerokości. Przecinający się asfalt jest odrzucany przed wymianą bieżącego toru. Renderer, kamera i fizyka korzystają z jednej geometrii; JSON starszych torów pozostaje zgodny.

Nawierzchnia jest próbkowana pod czterema kołami (rozstaw osi 3,6 m, szerokość 1,8 m). Wypadkowe μ stanowi średnią udziałów: asfalt 1,85, trawa 0,45, żwir 0,60. Dodatkowy opór przeciwny do całego wektora prędkości wynosi 0,04 g na trawie i 0,35 g na żwirze przy pełnym udziale nawierzchni. Impuls nie może odwrócić ruchu. To parametry uproszczonego modelu, nie kalibracja konkretnego toru. Pełny postój w żwirze może uniemożliwić ponowne ruszenie.

Przekroczenie białej linii nie powoduje DNF. Po lekkim kontakcie z bandą usuwana jest prędkość skierowana w bandę, a pozostała mnożona przez 0,8; bolid jest odsuwany o 3 cm. Prędkość prostopadła do bandy co najmniej 12 m/s kończy jazdę. Rozbite auto zostaje na torze jako wrak z lokalną żółtą flagą przez 15 s (`WRECK_CLEAR_SECONDS`), w treningu tak samo jak w wyścigu. W wyścigu nie ma respawnu; trening przywraca auto dopiero po usunięciu wraku. Telemetria pokazuje nawierzchnię i przyczynę eliminacji. Odzyskiwanie kontroli dostaje do 30 s bez checkpointu, pozostała jazda zachowuje dotychczasowy limit 10 s.

## Poprawki z audytu „argon” (28.10.2026)

Zewnętrzny audyt `Car.ts` wskazał błędy w bilansie cieplnym i brakujące mechanizmy. Każdą poprawkę mierzy ten sam zestaw: samotny ekspert (`seedRandom(1)`, 3 okrążenia, najlepsze z 2. i 3.) na Albert Park, Monzy, Monako, Red Bull Ringu i Silverstone oraz trening 20 aut na Albert Park (900 s, ziarna 145 / 456 / 789 / 1011 / 2024 / 3033). Punkt odniesienia (stan z 27.10.2026): ekspert 99,69 / 94,38 / 86,34 / 80,88 / 113,63 s (suma 474,91 s), trening: mediana czystych okrążeń średnio 107,5 s, 0,72 wypadku na minutę.

- **Ciepło zablokowanej osi.** Zablokowana oś nie grzała tarcz (słusznie), ale do opony trafiało tylko 1,2% jej pracy jak przy pełzaniu toczącej się opony, więc reszta znikała z bilansu cieplnego. Teraz `LOCKED_TYRE_HEAT` = 35% mocy ślizgu `|Fx|·v` grzeje bieżnik, a resztę bierze asfalt (stosunek efuzywności cieplnej gumy ok. 650 i asfaltu ok. 1250). Nie mnoży jej `TYRE_FRONT_HEAT`, bo to już moc, a nie ważony poślizg. W zakręcie przy 80 m/s blokada grzeje przód o ok. 20–30 K/s (`test-suspension`; ciepło na sekundę blokady przy 30/60/120 Hz w granicy 30%). Wariant 50% podnosił liczbę wypadków w treningu do 1,16 na minutę (sieci blokują koła częściej niż ekspert), przy 35% wynosi 0,64. Ekspert: suma 474,91 s bez zmian. Skrót stanu `bench:step` się zmienia.
- **Dwie warstwy temperatury opony.** Jedna pojemność 12 kJ/K (stała czasowa ok. 40 s) uśredniała poślizg w zakręcie do ułamka stopnia. Teraz oś ma bieżnik (`tyreSurfaceTemp*`, 3 kJ/K) i karkas (`tyreTemp*`, 9 kJ/K), połączone przewodzeniem 2000 W/K. Poślizg grzeje bieżnik, histereza (`0,0075·Fz·v`) i ciepło płaskiego miejsca przy blokadzie grzeją karkas (płaskie miejsce to jeden kawałek bieżnika, a nie cała powierzchnia). Powietrze i tor chłodzą bieżnik tym samym wzorem co dotąd, więc temperatura ustalona się nie zmienia. Bieżnik reaguje w ok. 1,3 s: w zakręcie jest o kilkanaście stopni cieplejszy od karkasu, w poślizgu dochodzi do 180–200 °C i stygnie na następnej prostej. Przyczepność liczy się z temperatury `0,5·bieżnik + 0,5·karkas` (`TYRE_SURFACE_GRIP_SHARE`); to samo widzą planista (limit „push”) i wejścia sieci. Zużycie zależy od temperatury bieżnika. Obie warstwy są całkowane razem niejawnie, więc wynik nie zależy od kroku (`test-suspension`: różnice < 0,6 °C przy 30/60/120 Hz). HUD pokazuje „bieżnik/karkas”.
  - Dobór: przy 220 W/K i 1,6 kJ/K (wartości z audytu) bieżnik w zakręcie był do 44 K cieplejszy od karkasu. Ekspert tracił ok. 1 s na Albert Park, a w wyścigu na GP wpadał w spiralę (poślizg → gorący bieżnik → mniej przyczepności → większy poślizg) i rozbijał się w 4 z 6 przejazdów. Przy 2000 W/K i 3 kJ/K przejeżdża wszystkie 6. Udział bieżnika 0,7 dawał 0,91 wypadku na minutę w treningu, 0,5 daje 0,74 (rozrzut między ziarnami 0,13–1,47).
  - Pomiar (przed → po): ekspert 474,91 → 475,29 s (suma pięciu torów), trening na Albert Park: mediana czystych okrążeń 107,5 → 106,6 s, najlepsze okrążenie średnio 101,6 → 101,2 s. Pełny pedał w zakręcie blokuje przód na ok. 10 z 30 kroków zamiast 15: blokada puszcza, gdy rozgrzany bieżnik znów trzyma.
- **Tarki.** Pas za białą linią był trawą (μ 0,45, opór 0,04 g), więc ścięcie zakrętu po tarce karało jak wyjazd. Teraz w zakrętach (`|krzywizna| > 0,003 /m`, ta sama reguła co rysunek) oba brzegi mają tarkę szeroką na 1,2 m (`Track.KERB_WIDTH`, nawierzchnia `'kerb'`). Ma ona 0,8 przyczepności asfaltu na sucho i 0,45 na mokrym (malowany beton, `Car.kerbGrip`), bez oporu gleby i z lekkimi nierównościami (`KERB_ROUGHNESS` 3 mm, trawa 6 mm). Granice toru się nie zmieniają: decyduje biała linia, więc dwa koła na tarce są w porządku, a cztery nie. Koła na tarce to nadal droga: `car.surface` pozostaje „asfalt”, planista i strażnik nie traktują tarki jak wyjazdu, HUD dopisuje „TARKA”. Rysunek 3D pokazuje tarki tam, gdzie są w fizyce, na obu brzegach zakrętu (wcześniej pas 1,2 m na linii, tylko od wewnątrz). Pomiar: ekspert 475,29 → 475,25 s, na Monako poza asfaltem 1,3 → 0,5% czasu; trening na Albert Park poza asfaltem 1,9 → 1,3% czasu, mediana czystych okrążeń 106,6 → 106,7 s.
- Uwaga z pomiaru: czas trwania blokady zależy od kroku symulacji (w tym samym manewrze 0,37 / 0,93 / 0,63 s przy 30 / 60 / 120 Hz), bo detektor blokady porównuje moment z przyczepnością z poprzedniego kroku. To zachowanie sprzed audytu.

## Wyprzedzanie kończy się, gdy rywal odjedzie (27.10.2026)

Plan wyprzedzania trzymał auto obok rywala, dopóki go nie minęło o 9 m. Gdy rywal odjechał, plan zostawał: auto jechało obok miejsca, w którym rywal był setki metrów dalej (w treningu na Albert Park z 20 autami w ok. 65% kroków z planem rywal był dalej niż 50 m, nawet 1,3 km). Przez to auto jeździło poza swoją linią i z prędkością zakrętów obniżoną o 12% przez dużą część okrążenia. Plan obejmował medianę 43% okrążenia, a w co czwartym okrążeniu całe. Teraz auto rezygnuje z wyprzedzania, gdy żywy rywal jest dalej niż 70 m (`PASS_ABANDON`), i wraca na swoją linię. Wraki omija jak dotąd. Działa tak samo w treningu, kwalifikacjach i wyścigu.

Trening na Albert Park (25 wiązek, mutacja 9%, 3000 s), mediana czystych okrążeń przed → po: 20 aut 121,8 → 107,4 / 121,8 → 112,0 / 116,9 → 108,2 s (ziarna 145 / 456 / 789), 5 aut 111,5 → 103,5 s. Samotne auto jeździ ok. 103–105 s. Czasy rosły dotąd z każdą generacją (106–110 → 117–128 s), a teraz w większości przebiegów stoją. Skrót stanu `bench:step` się zmienia.

## Szukanie tempa z median okrążeń i postój poza oceną (26.10.2026, wieczór)

Ten sam samochód rozrzuca okrążenia w stawce o ok. 3 s (5%: ruch, losowa przyczepność i moc, szerokie wyjścia), a samotnie, bez losowości, ten sam mózg powtarza czas co do 0,3 s. `PaceSearch` porównywał każde okrążenie z jednym najszybszym, więc po szczęśliwym okrążeniu niemal każde następne było „o 3% wolniejsze” i wracało do sprawdzonego marginesu, a każdy własny wyjazd odejmował 0,06. Teraz po 3 czystych okrążeniach na sprawdzonym marginesie auto jedzie 3 okrążenia na marginesie wyższym o krok i zostaje na nim, gdy mediana tych okrążeń jest lepsza od mediany ostatnich (do 8) okrążeń na sprawdzonym. Wyjazd na próbie wraca do sprawdzonego marginesu i ustawia sufit tuż pod próbowanym, a sufit odpręża się o 0,002 na czyste okrążenie. Sprawdzony margines cofa się o 0,03 dopiero po 2 własnych wyjazdach w 6 ostatnich okrążeniach na nim. Okrążenia stresowe i z wstrzykniętym błędem dalej nie liczą się jako wyjazdy.

Do tego okrążenie, na którym auto wjeżdża do alei serwisowej, nie ocenia już mózgu ani tempa (dotąd nieoceniane było tylko okrążenie po wyjeździe z alei, a linia mety może leżeć w alei). W treningu na GP takie okrążenia z całym postojem (83–92 s przy typowych ok. 60 s) liczyły się jako czyste.

Trening na GP (20 aut, ok. 150 gen., ziarna 145 / 456), przed → po: kierowcy przy minimum marginesu na końcu 17 → 9 / 9 → 7 z 20, średni sprawdzony margines 0,917 → 0,934 / 0,951 → 0,953, odchylenie czystych okrążeń 3,86 → 3,37 / 3,19 → 2,85 s, mediana czystych 60,26 → 60,33 / 59,65 → 59,87 s (bez wyraźnej zmiany). Skrót stanu `bench:step` się zmienia.

## Pomyłki AI i ochrona uczenia

Ryzyko wynosi `clamp((wykorzystaniePrzyczepności − 0,55) / 0,45, 0, 1)`. Zdarzenia mają prawdopodobieństwo `1 − exp(−ryzyko * dt / 600)` w kroku czasu symulacji. Przy pełnym ryzyku daje to średnio jedną pomyłkę na 10 minut ekspozycji, z 30 s przerwy po zdarzeniu. Pomyłka trwa 0,2–0,6 s i zmniejsza hamowanie do 25% żądania albo zmienia skręt o 0,08–0,20. Nie wymusza wypadnięcia, nie zmienia wag sieci i nie dodaje sił. Pomyłki działają w treningu i wyścigu; nie działają podczas postoju, ręcznego sterowania, odzyskiwania kontroli lub po finiszu.

Podczas pomyłki i odzyskiwania kontroli replay jest wyłączony i czyszczony. Dotknięte zdarzeniem lub wyjazdem na pobocze okrążenie liczy się w dystansie i czasie wyścigu, ale nie zastępuje PB, sieci mistrza ani profilu prędkości lidera i nie uruchamia cofnięcia za pogorszenie czasu. Po wyjeździe AI korzysta z geometrycznego celu na asfalcie, ogranicza gaz i hamuje zależnie od prędkości. Na powrót na asfalt ma 12 s (`Car.OFF_TRACK_RECOVERY_TIME`) — dopiero dłuższy ciągły pobyt poza asfaltem kończy się eliminacją „BRAK POSTĘPU”. Checkpointy pozostają uporządkowane i wymagają przejazdu po asfalcie.

## Ograniczenia

Wiatr jest jednorodny na całym torze (bez osłonięć trybunami). Brak pełnej mapy aero (docisk zależy od prześwitu, opór od niego nie zależy). Uszkodzenia ograniczają się do jednego skalara (docisk/opór). Zawieszenie, opony (temperatura, zużycie, wrażliwość na obciążenie) i skrzynię biegów opisują osobne sekcje. Model nie był kalibrowany względem danych konkretnego bolidu F1. Dawne czasy okrążeń i wagi AI nie są porównywalne z wynikami po zmianie fizyki oraz szerokości toru; zalecany jest nowy trening.

## Weryfikacja

`npm run test:learning` sprawdza ochronę modeli PB, odzyskiwanie po rozbiciu, ciągłość generacji, czyszczenie nieudanych próbek i mapowanie telemetrii lidera; zawiera test 400 sekund rzeczywistej pętli treningowej.

`npm run test:runoff` sprawdza generowanie i ograniczanie poboczy, nawierzchnie pod kołami, brak dodawania energii przez opór, lekkie i mocne zderzenia, szybkie przecięcie położenia bandy, powrót AI na asfalt, kolejność checkpointów i ochronę PB. Statystykę zdarzeń porównuje przy 30/60/120 krokach na sekundę; dodatkowo wykonuje trzy testy rzeczywistej jazdy po 600 sekund.

`npm test` uruchamia oba zestawy oraz sprawdza limity sił, hamowanie od spoczynku i w obu kierunkach, telemetrię, jazdę bokiem, brak paliwa, postój bez tankowania i zegary, skalę, obrys oraz ukończenie okrążeń GP przez AI. Test workera z kontrolowanym zegarem sprawdza 1× przy tickerach 16 ms i 20 ms oraz pauzę. Dodatkowo sprawdza checkpointy pól startowych, ukończenie 10-okrążeniowego wyścigu przez AI, zamrożenie czasu po mecie i powrót do treningu. `npm run audit:physics` wypisuje wyniki numeryczne; `npm run build` sprawdza TypeScript i bundlowanie.

`docs/archive/AUDIT_PHYSICS.md` zachowuje dowody stanu sprzed napraw. Poprawiono osiem opisanych tam problemów i akumulator czasu; dynamika poślizgu (model jednośladu) i kontakty między bolidami doszły później (opisane niżej). Od 25.10.2026 aleja serwisowa ma własną geometrię (patrz „Aleja serwisowa”).

### Krótkie ataki na rywala

W treningu, kwalifikacjach i wyścigu AI może podjąć próbę szybszego przejazdu, gdy rywal jedzie 2–35 m przed nim na tym samym odcinku, w zgodnym kierunku i na tym samym okrążeniu. Przy ciągłej okazji częstość rozpoczęcia wynosi średnio raz na 15 s czasu symulacji (p = 1 − exp(−dt/15)). Atak trwa 3–6 s, potem obowiązuje 20 s przerwy. Docelowa prędkość zakrętu rośnie o 4%, a szacowana zdolność hamowania o 8%, co opóźnia rozpoczęcie hamowania; rzeczywista moc i siły przyczepności nie zmieniają się. To założenia modelu, a nie statystyki prawdziwych kierowców.

Po utracie rywala, poślizgu, pomyłce, wyjeździe na pobocze lub zgłoszeniu pit stopu AI odpuszcza. Ręczne sterowanie nie uruchamia ataków. Telemetria pokazuje „ATAK: nazwisko”. Okrążenie liczy się w wyścigu, ale tam nie zastępuje rekordowej sieci ani wyników oceny modelu; próbki sterowania podczas ataku są wyłączone. Funkcja zmienia tempo jazdy; współpracuje z osobnym planowaniem linii wyprzedzania i modelem kolizji.

### Kontakt bolidów w wyścigu

Bolidy w wyścigu mają nieprzenikające prostokątne obrysy 5,5 × 1,8 m. Ciągły test osi rozdzielających wykrywa kontakt na całej drodze ruchu; obrót dzielony jest na małe odcinki. Lekkie uderzenie rozdziela auta i stosuje niesprężysty impuls w punkcie styku, z tarciem (szczegóły w sekcji „Kontakt auto–auto: obrót i tarcie”). Składowa prędkości względnej skierowana w kontakt ≥ 12 m/s (`Car.CRASH_CLOSING_SPEED`) oznacza wypadek i DNF obu uczestników. Jest to uproszczony próg modelu. Uszkodzone auta pozostają przeszkodami. Telemetria podaje „WYPADEK Z INNYM BOLIDEM”. Zdarzenie wyklucza okrążenie z oceny sieci, ale czas wyścigu nadal liczy się normalnie.

AI ogranicza gaz i hamuje przed pojazdem w swoim korytarzu jazdy, uwzględniając odległość i prędkość zbliżania. Dotyczy to także dublowanych i zatrzymanych samochodów. Atak ustępuje hamowaniu bezpieczeństwa. Sterowanie ręczne nie jest korygowane, ale jego kolizje są fizyczne. Trening również uwzględnia kontakt i unikanie innych aut. Po wypadku model jest zachowany, a bolid stoi jako wrak 15 s (żółte flagi jak w wyścigu) i wraca, gdy porządkowi go usuną, a jego miejsce startowe jest wolne. Wyprzedzanie korzysta z bocznego przesunięcia celu sterowania, opisanego niżej.

`npm run test:traffic` sprawdza najechanie od tyłu przy dużej prędkości, krzyżowanie trajektorii, lekkie kontakty, rozdzielenie obrysów, energię oraz hamowanie przed wolniejszym i zatrzymanym rywalem.

### Linie wyprzedzania i lokalne żółte flagi

AI wybiera wolną linię po lewej lub prawej stronie rywala, z odstępem bocznym 3,2 m. Przesunięcie celu rośnie płynnie maksymalnie o 1,8 m/s; zmienia wyłącznie punkt, do którego kieruje samochód. Ruch wynika z istniejącej fizyki, bez teleportacji. Kandydat musi mieścić się na asfalcie z zapasem 1,6 m od krawędzi i nie kolidować z pobliskimi autami ani ich zaplanowanymi liniami. Przy bocznej linii prędkość docelowa zakrętu jest obniżona o 12%, by zachować zapas na zmieniony promień jazdy. Odstęp i hamowanie przed rywalem są mierzone wzdłuż krzywej trasy. AI utrzymuje linię do minięcia rywala o 9 m i wraca dopiero, gdy środkowy korytarz jest wolny. Gdy rywal odjedzie dalej niż 70 m (`PASS_ABANDON`), AI rezygnuje z wyprzedzania i wraca na swoją linię. Na zbyt wąskim lub zajętym torze czeka i hamuje. W wyścigu ocena rekordowej sieci nie korzysta z okrążeń wspomaganych planowaniem ruchu w stawce; w treningu korzysta (patrz „Trening = wyścig”). Na długiej prostej (zakręt dalej niż 200 m) auto jedzie w cieniu aerodynamicznym rywala i wychodzi do wyprzedzania z 18 m; przed strefą hamowania broniący się kierowca raz zajmuje wewnętrzną. Holowanie, obrona i wyprzedzanie działają tak samo w treningu, kwalifikacjach i wyścigu, a w kwalifikacjach i wyścigu okrążenie z planem wyprzedzania nie jest okrążeniem wzorcowym (w treningu nadal ocenia model, patrz „Trening = wyścig”).

Każdy nieusunięty DNF stojący na asfalcie lub najwyżej 5 m za jego krawędzią (`YELLOW_EDGE_MARGIN`, od 25.10.2026) tworzy lokalną żółtą strefę od 200 m przed wrakiem do 30 m za nim, liczoną wzdłuż trasy także przez metę. W niej AI odpuszcza atak, nie wybiera linii wyprzedzania żywych rywali i hamuje do 22 m/s (około 79 km/h). Omijanie nieruchomego wraku pozostaje dozwolone. Hamowanie bezpieczeństwa dotyczy również ręcznego sterowania przy żółtej fladze. To uproszczone zasady symulacji, nie odwzorowanie regulaminowego systemu sędziowania. Żółta flaga jest widoczna w telemetrii i etykietach aut. Oczekiwanie przy prędkości poniżej 3 m/s za blokującym pojazdem nie uruchamia DNF za brak postępu.

Porządkowi usuwają wrak po 15 s czasu symulacji (`WRECK_CLEAR_SECONDS`), w każdej sesji. Potem wrak znika z renderowania oraz wykrywania kolizji i przeszkód; kierowca zachowuje DNF w klasyfikacji. Gdy w danej strefie nie ma kolejnego wraku, żółta flaga gaśnie.

### Zgodność rysunku i kolizji

Rysowany bolid ma ten sam obrys 5,5 × 1,8 m co fizyczny model kontaktu. Koła, skrzydła i pozostałe stałe elementy są ograniczone do tego obrysu, zamiast dawnego powiększonego znacznika 9 × 3 m. Efekty dymu, podpisy i zaznaczenie kierowcy pozostają nakładkami. Wzajemne kolizje, hamowanie przed rywalem i wybór bocznej linii działają także w domyślnym treningu. Reset miejsca po wypadku nie jest traktowany jako ruch przez tor, a zajęty slot opóźnia respawn.

### Ciągłość treningu bez czystego rekordu

Automatyczna zmiana generacji nie tworzy ponownie stawki. Zachowuje wszystkie obiekty bolidów, pozycje, prędkości, paliwo, bieżące okrążenia i aktywne sieci, także gdy kierowca nie ma jeszcze czystego PB. Wyprzedzanie, pomyłki i ruch pod żółtą flagą nie pozbawiają tej ochrony. Martwy bolid nadal czeka na swój indywidualny respawn. Dopiero ręczna „Nowa Gen” ustawia całą stawkę na starcie.


## Sieć neuronowa jako kierowca (stan po audycie z 11.10.2026)

Wyjścia sieci `[skręt, gaz, hamulec]` są faktycznym sterowaniem (`Car.getAIControl`, `decodeDriverOutputs`). Regułowy kontroler (`Car.planDrive`: pościg geometryczny + profil prędkości z krzywizny) jest teraz **nauczycielem** i **strażnikiem**:

- **Destylacja** (`src/ai/Distill.ts`): nowa sieć uczy się naśladować nauczyciela na prawdziwym torze (240 s jazdy z zakłóceniami skrętu i losowymi przesunięciami linii, etykiety nauczyciela w odwiedzonych stanach — DAgger). Wynik jest cache'owany na tor/topologię. `NeuralNetwork.createTrainedDriverNetwork(rays, topology, track?)` bez toru korzysta z presetu GP.
- **Autorytet sieci:** skręt w korytarzu ±0,3 wokół skrętu geometrycznego, gaz i hamulec w pełnym zakresie; pedały wykluczają się: przy dekodowaniu wygrywa silniejsze wyjście (szczątkowe 3–4% hamulca nie zeruje pełnego gazu — wcześniej przy zimnych oponach sieć „toczyła się” całe okrążenia na 1. biegu).
- **Strażnik** przejmuje sterowanie tylko przy: zjeździe z asfaltu, bliskości bandy, żółtej fladze, postoju w boksie, odzyskiwaniu kontroli, nadmiernej prędkości względem planu hamowania (hamowanie awaryjne), postoju z gazem wymaganym przez nauczyciela (launch assist).
- **Uczenie:** (1) ewolucja — mutacje rekordowych sieci i selekcja po czasie okrążenia (PB), (2) online backprop wyłącznie w stanach, w których strażnik musiał interweniować (korekta typu DAgger).
- Planowane opóźnienie hamowania: `Car.PLANNED_BRAKE_DECEL = 8,5 m/s²` × agresja (wcześniej 6,0).

`npm run diag:nn -- 600` pokazuje okrążenia, DNF i rekordy zespołów; `--expert` porównuje z samym nauczycielem.

## Dynamika poślizgu

Model jednośladu (`Car.updatePhysics`): kąty znoszenia osi → siła boczna `Fy = Fmax·tanh(Cα·α/Fmax)` (Cα = 22·Fz, Fmax z koła tarcia osi) → moment na bryłę o bezwładności `Iz = 1,3·m`. Napęd i hamowanie mają **priorytet stabilności**: oś zachowuje siłę boczną użytą w poprzednim kroku (×1,1), a napęd/hamulec dostają resztę koła tarcia (jak TC/ESC). Skręt koła podąża za poleceniem z opóźnieniem 0,09 s.

Płynny skręt (24.10.2026): opóźnienie skrętu to teraz dwa równe stopnie pierwszego rzędu po 0,045 s (dłonie i przekładnia), rozwiązane dokładnie dla polecenia stałego w kroku, więc wynik nie zależy od częstotliwości kroku. Wcześniej jeden stopień 0,09 s ruszał koła z pełną prędkością w chwili skoku polecenia (przejęcie sterowania przez strażnika, oddanie go sieci, skok wyjścia sieci) i koła „przeskakiwały” bez rozpędu. Cel pościgu geometrycznego rośnie z prędkością bez górnej granicy (`max(8, 5 + 0,25·v)` m, wcześniej do 14 m). Pościg prostuje błąd kursu w czasie ok. `cel/(2·v)`, przy 14 m i 80 m/s to 0,09 s, czyli tyle, co opóźnienie skrętu: koła piłowały wtedy kilka razy na sekundę, a sieć uczyła się tego od nauczyciela. Pomiar (10 bolidów, tor GP, po 200 s): skoki kół (przyspieszenie kątowe > 1500 °/s²) 0,13 → 0,03 na bolid na sekundę, najostrzejsze szarpnięcia (p99,99) ok. 5500 → 2250 °/s² (4 ziarna); odpadnięcia 29 → 13, czas poza asfaltem 3,1% → 2,4% (8 ziaren). `bench-laptime` (600 s): najlepsze okrążenie 54,11 → 53,10 s, mediana rekordów 59,9 → 58,1 s. Sam nauczyciel solo jest ok. 0,3 s wolniejszy (54,3 → 54,6 s).

Skutki: podsterowność przy nasyceniu przedniej osi, nadsterowność przy nasyceniu tylnej, `isSkidding`/`understeerSlip`/`oversteerSlip` wynikają z kątów znoszenia, a nie z samego żądania. Kierowca regułowy ma sprzężenie od prędkości kątowej i ogranicza skręt do tego, co wykorzystuje oś. Poniżej ok. 8–16 m/s, gdzie kąty znoszenia są źle uwarunkowane, odpowiedź płynnie przechodzi w kinematyczną.

## Kolizje, uszkodzenia, wraki

- `Car.damage` (0…1) rośnie o `(v/12)²` przy każdym kontakcie od 3 m/s (`Car.CONTACT_DAMAGE_MIN_SPEED`; bandy i inne auta) i zatrzymuje się na 1. DNF daje tylko pojedynczy kontakt ≥ 12 m/s (`Car.CRASH_CLOSING_SPEED`); od 25.10.2026 suma uszkodzeń nie kończy jazdy. Uszkodzenie zmniejsza docisk do 35% i zwiększa opór do 15%; postój w boksie naprawia, a AI zjeżdża po nowe skrzydło od uszkodzenia 0,5 (`PIT_DAMAGE_LIMIT`, w każdej sesji, nie na ostatnich 2 okrążeniach wyścigu).
- Banda: impuls z tarciem Coulomba (styczna prędkość maleje proporcjonalnie do uderzenia), zamiast mnożenia przez 0,8 w każdym kroku; uderzenie poza osią skręca auto.
- Wrak zachowuje pęd i zwalnia 12 m/s² (`Car.coastWreck`), zatrzymuje go banda; ślizgający się wrak jest ruchomą przeszkodą w kontaktach.
- Od 24.10.2026 pomijana jest tylko para wraków, które oba stoją (prędkość < 0,5 m/s i brak ruchu w tym kroku). Wcześniej pomijano każdą parę wolnych wraków, więc wrak wyhamowujący z ok. 0,6 m/s mógł wsunąć się o ok. 1 cm w drugi wrak i zostać w nim (`test-traffic`, ziarno 145 po zmianie linii jazdy). Wrak, który w tym kroku się przesunął, jest przy rozdzielaniu ruchomy.
- `src/math/Random.ts`: `seedRandom(n)` daje powtarzalną symulację (domyślnie `Math.random`).

## Poszukiwanie limitu i linii (trening)

- `PaceSearch` (`src/ai/PaceSearch.ts`): auto, które zostaje na asfalcie, może mieć zapas, więc po 3 czystych okrążeniach próbuje przez 3 okrążenia wyższej planowanej przyczepności w zakrętach i hamowania (`margin` 0,9–1,15; hamowanie zmienia się o połowę tego, co zakręty) i zostaje przy niej, gdy mediana próby jest lepsza od mediany okrążeń na sprawdzonym marginesie; inaczej wraca i próbuje drobniejszym krokiem. Wyjazd na próbie wraca do sprawdzonego marginesu i obniża sufit, a 2 wyjazdy w 6 okrążeniach na sprawdzonym marginesie cofają go o 0,03, ale tylko wtedy, gdy to błąd samej sieci: wyjazd lub rozbicie na okrążeniu stresowym albo po wstrzykniętym błędzie kierowcy (`DriverMistakes`) margines zostawia. W wyścigu używany jest sprawdzony `bestMargin`.
- `LineSearch`: oprócz 5 bazowych linii mutacje (co 2. okrążenie) przesuwają linię osobno w 16 odcinkach toru (`trim`, do ±2,2 m), czyli wcześniejszy/późniejszy wierzchołek, szersze wejście itd. Zwycięska linia jest zachowana, a nowa kandydatka testowana obok.

## Wyjścia pedałów i linia z sieci (`LineNet`)

- Gaz i hamulec nigdy nie działają razem: w `updatePhysics` każde żądanie hamowania > 0,02 zeruje gaz, a mniejsze jest odrzucane (dotyczy sieci, eksperta i sterowania ręcznego).
- Linia przejazdu pochodzi z osobnej sieci (`src/ai/LineNet.ts`). Wejścia: promienie LiDAR, prędkość, zakrzywienie toru w 4 punktach przed autem, położenie boczne i błąd kursu. Wyjście: pożądane położenie boczne jako ułamek użytecznej szerokości (do połowy szerokości − 2,3 m). Start: sieć wydestylowana z linii zewnątrz–wewnątrz–zewnątrz, która wykorzystuje całą szerokość.
- Uczenie: zmutowana kopia jedzie jedno okrążenie i zostaje mistrzem tylko, gdy jest szybsza; co 4. okrążenie mistrz jest mierzony ponownie (szum gripu/mocy). Linia sama nie kosztuje prędkości — kara za offset dotyczy tylko odchylenia od linii (wyprzedzanie).
- Najlepsza trasa jest rysowana cieńszą kreską.

## ERS / MGU-K

Jednostka napędowa według regulaminu 2026 (bez MGU-H):

- Moc napędu = ICE 400 kW · gaz · f(obroty) + MGU-K do 350 kW (razem nadal 750 kW). Bateria: 4 MJ użytecznego okna (`ERS_CAPACITY`).
- Oddawanie przy gazie > 0,65. Moc MGU-K maleje liniowo od 290 km/h do zera przy 355 km/h (`ERS_TAPER_START/END`).
- Kontrola trakcji dozuje moment MGU-K: oddaje on tylko tyle mocy, ile tylne opony przeniosą ponad moc ICE. Przy ruszaniu i na wyjściu z wolnego zakrętu (ograniczenie trakcją) bateria się więc nie rozładowuje bez pożytku.
- Zarządzanie energią: pełna moc oddawania od 40% baterii (`ERS_LOW_SOC`), poniżej maleje liniowo do zera przy 10% (`ERS_CLIP_SOC`). Dzięki temu energia oddana na okrążeniu zbliża się do odzyskanej, a bateria nie spada skokowo do clippingu.
- Poniżej 10% przy pełnym gazie następuje „super clipping”: MGU-K ładuje baterię mocą 50 kW, odbierając ją z napędu.
- Odzysk ograniczony do 8,5 MJ na okrążenie (`ERS_LAP_HARVEST`, licznik zerowany na linii mety):
  - hamowanie do 350 kW, niezależnie od siły nacisku na pedał (brake-by-wire najpierw używa MGU-K), ale nie więcej niż moc rozpraszana przez hamulce;
  - lift-and-coast powyżej 30 m/s: 105 kW;
  - częściowy gaz: do 100 kW · gaz (ICE napędza MGU-K jako generator);
  - sprawność 88%.
- Na torze Grand Prix (szer. 14 m) bateria stawki po 200 s treningu stoi na ok. 38–99% (`diag:nn`; przed zmianą z 25.10.2026 39–70%). W modelu sprzed 13.10.2026 (120 kW oddawania, 350 kW odzysku) stała zwykle na 90–95%.
- Przy ograniczeniu trakcją (niskie prędkości) dodatkowa moc nie przyspiesza; różnicę widać powyżej ok. 60 m/s. W telemetrii: „ERS xx%”.

### Przyspieszenie: MGU-K według trakcji i pełna moc od 40% baterii (25.10.2026)

Wcześniej moc oddawania rosła liniowo ze stanem baterii od 10% do 90%, a MGU-K oddawał ją także wtedy, gdy siłę napędową ograniczała przyczepność. Na starcie bateria traciła więc ok. 0,9 MJ, a auto nie przyspieszało ani trochę szybciej. Potem, przy stanie baterii typowym na torze (40–70%), MGU-K dawał tylko 110–250 kW zamiast 350 kW. Pomiar (start z miejsca, pełny gaz, płaska prosta, 105 kg paliwa, opony 85 °C, krok 1/60 s):

| | przed | po | F1 (orientacyjnie) |
|---|---|---|---|
| 0–100 km/h, bateria 85% | 2,50 s | 2,50 s | ok. 2,5–2,6 s |
| 0–200 km/h, bateria 85% | 4,92 s | 4,72 s | ok. 4,5–4,8 s |
| 0–300 km/h, bateria 85% | 11,7 s | 8,35 s | ok. 8,5–9,5 s |
| 0–200 km/h, bateria 50% | 5,22 s | 4,72 s | |
| 0–300 km/h, bateria 50% | 15,1 s | 11,3 s | |

0–100 km/h ogranicza trakcja tylnej osi (ok. 1,13 g), więc się nie zmienia. Sam próg 40% bez dozowania według trakcji pogarszał okrążenie (najlepsze 54,52 → 55,20 s, mediana rekordów 58,44 → 59,76 s), bo bateria opadała do 12–58%. Z dozowaniem `bench-laptime` (600 s, ziarna 145/456/789) daje: najlepsze okrążenie 54,52 → 54,54 s, mediana rekordów 58,44 → 58,12 s, czyli w granicach rozrzutu ziaren. Zmiana dotyczy wszystkich sesji jednakowo. Test: `test-neural-driving` (0–100 w 2,35–2,65 s, 0–200 < 4,85 s także przy 50% baterii, 0–300 < 9 s, energia MGU-K do 100 km/h < 300 kJ).

## Pogoda (`src/physics/Weather.ts`)

- Stan: zachmurzenie, deszcz, temperatura powietrza i toru, wilgotność toru W, wiatr (średnia, kierunek, mnożnik porywu). Ewoluuje z krokiem symulacji, z własnym generatorem (mulberry32) z ziarnem, niezależnym od `random()` symulacji.
- Zachmurzenie: proces Ornsteina-Uhlenbecka wokół średniej prognozy; „przelotny deszcz” ma jedno okno opadu (start po 3–8 min, 4–8 min). Deszcz = `skala·(chmury − próg)/(1 − próg)`.
- Tor: relaksacja (τ = 240 s) do `T_pow + 13·słońce·(1 − chmury)·(1 − 0,8·W) − 2·deszcz`. Powietrze: baza − 4 °C·deszcz (τ = 300 s).
- Woda: deszcz moczy tor do poziomu `0,35 + 0,75·deszcz` (pełna ulewa w ok. 2 min), parowanie `W/520 s · (0,3 + słońce·(1 − chmury))·(T_toru − 5)/30 · (1 + 0,04·wiatr)`: każdy m/s średniego wiatru suszy o 4% szybciej (od 23.10.2026).
- Gęstość powietrza (od 23.10.2026): `ρ = 1,225·(273,15 + 25)/(273,15 + T_pow)` (gaz doskonały przy stałym ciśnieniu). Przy 25 °C wynosi dokładnie 1,225 kg/m³, więc kalibracja słonecznej pogody się nie zmienia; przy 5 °C ok. 1,31 (więcej docisku i oporu, prędkość maksymalna ok. 6 km/h niższa), przy 35 °C ok. 1,185. Planista zakrętów i hamowania używa tej samej gęstości.
- Aquaplaning (od 23.10.2026): slick na stojącej wodzie (W > 0,6) powyżej 200 km/h traci przyczepność: `0,5 · (W − 0,6)/0,4 · min(1, (v − 200 km/h)/100 km/h)`. Intery i deszczówki odprowadzają wodę. HUD: „⚠ AQUAPLANING”. Planista tego nie przewiduje; AI na mokrym torze i tak zjeżdża po opony z bieżnikiem.
- Wiatr: porywy OU (τ = 3 s, σ wg prognozy), kierunek dryfuje o ok. ±15° (τ = 60 s).
- Aero: prędkość względem powietrza `v_pow = v − wiatr`. Opór `½ρ·CdA·|v_pow|²` przeciw `v_pow`, docisk `½ρ·ClA·|v_pow|²·(1 − 0,6·sin²β)`, gdzie β to kąt napływu; 60% straty z wiatru bocznego pochodzi z przedniej osi. Siła boczna `½ρ·1,5 m²·|v_pow|·v_wiatru,bok` działa 0,3 m za środkiem masy i daje moment odchylający w modelu dynamicznym. W bezwietrznej pogodzie wzory redukują się do poprzednich.
- Trening: klasa warunków sesji (sucho < 0,15 ≤ wilgotno < 0,6 ≤ mokro, z histerezą) i pasma okrążenia (0–0,2 / 0,1–0,65 / 0,55–1). Okrążenie poza pasmem jest „skompromitowane” dla uczenia. `Population.setConditions` przy zmianie klasy ustala nowy rekord odniesienia przy pierwszym czystym okrążeniu, a mózg mistrza zostaje.
- Test: `npm run test:weather`.

## Opony: temperatura i zużycie (na oś)

- Od 28.10.2026 temperatura osi ma dwie warstwy (opis w sekcji „Poprawki z audytu »argon«”). Bilans poniżej opisuje ciepło całej opony: poślizg trafia w bieżnik, histereza i blokada w karkas, chłodzenie działa na bieżnik.
- Stan: temperatura i zużycie osi przedniej i tylnej. Bilans: ciepło z mocy poślizgu bocznego (`siła · prędkość · tan α`, ×2), z pełzania wzdłużnego (1,2% `|Fx|·v`, przy zablokowanej osi 35% `|Fx|·v` bez mnożnika przodu), z histerezy (`0,0075·Fz·v`), oś przednia ×1,6; chłodzenie konwekcją `∝ v^0,8` i torem; pojemność 12 kJ/K (stała czasowa ok. 40 s).
- Mnożnik przyczepności osi: dzwon temperaturowy (optimum 100 °C, zimno do 0,80, przegrzanie do 0,75) razy zużycie (do −25% przy W=1). Wchodzi do limitów osi i do planowanej przyczepności (kierowca zwalnia na zimnych/zużytych oponach).
- Model opon działa zawsze, tak samo w treningu i w wyścigu (bez przełącznika „koców”). Auto startuje z 85 °C; pit stop daje nowy komplet. Zużycie > 70% wywołuje zjazd do boksu (patrz „AI, paliwo i postój”).
- Kalibracja (`npm run diag:nn`): temperatury ok. 80–115 °C, tempo wyścigowe ok. 3–5% wolniejsze od treningowego.
- Rekalibracja 24.10.2026 (`TYRE_HEAT_SCALE` 1 → 0,75): po szybszym planiście zakrętów z 21.10 opony wyszły z okna. Samotny ekspert na GP miał 126 °C przy `pace` 1,0 i 135 °C przy 1,15 (przyczepność ok. 0,85–0,89). Ostrzejsza jazda tylko grzała opony mocniej, więc `PaceSearch` nie dawał zysku (58,24 → 57,82 s), a „push” w zakręcie (do 125 °C) prawie nigdy się nie włączał. Po zmianie (`diag:nn -- 600`, ziarna 1–3): temperatury w treningu p10/p50/p90 ok. 85/97/111 °C (wcześniej 95/113/126), średni najlepszy czas 60,06 → 58,13 s. `node scripts/diag-corners.mjs` (ekspert, 6 ziaren): 58,24 → 55,88 s przy `pace` 1,0 i 55,19 s przy 1,15. Wyższy sufit `PaceSearch` (1,25) i większy budżet hamowania (`PLAN_BRAKE_GRIP` > 0,55) sprawdzono w tym samym skrypcie: dawały więcej wypadnięć i blokowania kół, więc zostały bez zmian. Od 25.10.2026 `PLAN_BRAKE_GRIP` wynosi 0,55, a pedał w zakręcie ogranicza koło tarcia (patrz „Budżety planisty i hamowanie w zakręcie”).
- Pogoda (`Weather.ts`): powietrze i nawierzchnia z bieżącej pogody zastępują stałe 25 / 38 °C (`TYRE_AMBIENT` / `TYRE_TRACK` to wartości pogody odniesienia). Chłodzenie: `2·(15 + 3,2·v^0,8)·(T − T_pow) + 60·(T − T_toru)`, razy `(1 + 0,9·W)` na mokrym.
- Niezależność od kroku (`test-suspension`): prosta, stały zakręt oraz cykl hamowanie/przyspieszanie, każdy po 20 s przy 30/60/120 Hz. Różnice temperatury < 1,5 °C, zużycia < 5% (zmierzone: 0,9 °C i 2,3% w zakręcie).

## Hamulce: temperatura i blokowanie kół (23.10.2026)

Model działa zawsze, w treningu i w wyścigu, bez przełącznika.

- Tarcze na oś: praca hamowania (siła · prędkość) grzeje tarcze, przepływ chłodzi je `30 + 5·v` W/K; pojemność 3,2 kJ/K przód i 2,4 kJ/K tył. Całkowanie dokładne (relaksacja wykładnicza), więc wynik nie zależy od kroku (test: 30/60/120 Hz < 2 °C). MGU-K przejmuje część pracy tylnej osi, więc tył grzeje się mniej. Start 300 °C.
- Okno pracy 350–950 °C: poniżej skuteczność rośnie liniowo od 0,7 przy temperaturze powietrza, powyżej spada do 0,65 przy 1300 °C. Skuteczność mnoży moment przednich (hydraulicznych) hamulców z pedału (pedał nadal oznacza ułamek przyczepności auta). Tył to brake-by-wire: sterownik realizuje zadany moment najpierw MGU-K, resztę tarczą, niezależnie od jej temperatury. Ponieważ MGU-K przejmuje większość pracy tylnej osi przy typowym hamowaniu AI, tylne tarcze w treningu pozostają chłodne. Hamowanie z 300 do 72 km/h: zimne tarcze (25 °C) wydłużają drogę o ok. 13 m; tarcze przód dochodzą do ok. 720 °C. W treningu na GP szczyt to ok. 550–620 °C.
- Rozkład 60/40 (wcześniej 56/44): przy pełnym hamowaniu przód przenosi ok. 61% obciążenia, a 44% z tyłu blokowałoby tył na prostej.
- Brak ABS: oś blokuje się, gdy moment hamulca przekracza o 15% to, co opona może przenieść wzdłuż drogi na swoim kole tarcia (z bieżącą siłą boczną), dłużej niż 0,1 s (czas wyhamowania koła). Zablokowana oś ślizga się z 85% przyczepności, zachowuje 30% siły bocznej (auto jedzie prosto), praca idzie w oponę i asfalt zamiast w tarczę (od 28.10.2026 35% pracy ślizgu `|Fx|·v` grzeje bieżnik, `LOCKED_TYRE_HEAT`), a płaskie miejsce dodaje 1% zużycia na sekundę. Oś odblokowuje się, gdy moment spadnie poniżej możliwości opony. HUD: „⚠ BLOKADA KÓŁ”, temperatury tarcz przy oponach.
- Pełny pedał na prostej na suchym nie blokuje kół; pełny pedał w zakręcie blokuje przód. Planista uwzględnia skuteczność tarcz (wcześniej hamuje i mocniej wciska pedał na zimnych lub przegrzanych tarczach).
- Pomiar wpływu całego etapu (gęstość, wiatr, aquaplaning, hamulce; trening `Population`, 180 s, ziarna 1–8, przed → po): słonecznie 322 → 316 okrążeń, DNF 70 → 66, średni najlepszy czas 53,52 → 53,76 s; deszcz 206 → 204 okrążenia, DNF 62 → 70. Różnice mieszczą się w rozrzucie między ziarnami. Koła są zablokowane w ok. 0,5% kroków auta na suchym i ok. 1,3% w deszczu; tarcze przód dochodzą w treningu do ok. 500–620 °C. Pierwsza wersja (blokada względem budżetu z rezerwą stabilności, rozkład 56/44) blokowała tył na prostej, obniżyła liczbę okrążeń o ok. 30% i podwoiła liczbę DNF, więc ją odrzucono.
- Test: `npm run test:weather`.

## Trening = wyścig (23.10.2026)

Zachowanie aut i warunki sesji nie zależą od `isRaceMode`. W każdej sesji: wrak stoi 15 s z lokalną żółtą flagą (`updateRaceSafety` w każdym `Population.update`; trening respawnuje auto dopiero po `wreckRemoved`, także gracza), ataki (`BattlePush`), jazda w cieniu na prostej, obrona przed hamowaniem i wyprzedzanie. Trudne okrążenia (szum LiDAR, rozrzut przyczepności i mocy) działają w każdej sesji, także dla nauczyciela w `Distill.ts`. Trening przy respawnie losuje paliwo z zakresu wyścigowego (`src/race/RaceFuel.ts`). Usunięto przywracanie sprawdzonej sieci po poślizgu w wyścigu (w wyścigu sieć i tak jest sprawdzoną kopią) oraz martwe zapisy trybu na stronie (`main.ts`).

`isRaceMode` zostaje tylko tam, gdzie chodzi o uczenie albo zasady sesji:
- DAgger i bufor próbek (`Population.ts`, `getAIControl(..., !isRaceMode)`), respawn z mutacją (`Population.update`), ewolucja (`evolve`, auto-cykle), `lineSearch/lineNet.finish` i `shakeBrain` w `recordLap`;
- resety rekordów przy zmianie warunków (`Population.setConditions`, `recordLap`) i `offConditions` w `LapTiming.ts`;
- trudne okrążenie oznacza `lapCompromised` i nieważny sektor tylko w treningu (`Car.rollLapPerformanceVariation`, `timeSector`);
- walka (atak, plan wyprzedzania, omijanie wraku) i żółta flaga oznaczają `lapCompromised` tylko w kwalifikacjach i wyścigu (`Population.update`, `planRaceLine`, `updateRaceSafety`). W treningu stawka 20 aut walczy niemal stale, więc takie okrążenie nadal ocenia model; nie ocenia go tylko kontakt lub uszkodzenie, wyjazd poza tor, trudne okrążenie, okrążenie poza klasą warunków (i jak dotąd: okrążenie wyjazdowe z alei, zmiana presji). Próbki DAgger z ataku i spod żółtej flagi są nadal odrzucane, bo ekspert jedzie wtedy inaczej niż na czystym okrążeniu;
- sprawdzony zamiast próbnego marginesu tempa (`DrivePlanner.ts` → `PaceSearch.value`) i linii (`LineNet.target`, wołane z `RaceTraffic.ts`);
- wyspy nie podmieniają modeli w wyścigu (`Islands.ts`);
- zasady kwalifikacji i wyścigu w `RaceSession.ts` (wypuszczanie z garażu, dolewanie do 20 kg, paliwo na dystans, klasyfikacja).

Pomiar (trening `Population`, tor GP, 180 s, ziarna 1–8, przed → po wszystkich zmianach):
- słonecznie: okrążenia 316 → 286, czyste okrążenia 102 → 18, nowe rekordy zespołów 78 → 13, zespoły z czasem 74 → 12 (na 160), DNF 66 → 72 (bandy 11 → 6, kontakt 45 → 29, utknięcie 10 → 37), najlepszy czas sesji (średnia ziaren z czasem) 53,76 → 53,54 s;
- deszcz: okrążenia 204 → 187, czyste okrążenia 72 → 9, nowe rekordy 72 → 9, zespoły z czasem 69 → 9, DNF 70 → 54.
- Udział zmian w spadku czystych okrążeń (słonecznie): wraki 102 → 70, walka w treningu 70 → 8, trudne okrążenia i paliwo bez wyraźnej zmiany (17–18). Bez kompromitowania okrążenia przez plan wyprzedzania byłoby 32 czyste okrążenia. Utknięcia rosną, bo auta czekają za wrakami; w wyścigu jest tak samo.
- `npm run bench:step`: 515 → 492 µs/krok (bez regresji; skrót stanu zmienia się, bo zmienia się jazda).
- Po zmianie księgowania (walka i żółta flaga nie unieważniają okrążenia treningowego; te same warunki pomiaru, przed zmianą → po, w nawiasie stan sprzed całego etapu):
  słonecznie czyste okrążenia 18 → 92 (102), nowe rekordy 13 → 77 (78), zespoły z czasem 12 → 70 (74), okrążenia 286 → 267 (316), DNF 72 → 97 (66), najlepszy czas sesji 53,54 (6 ziaren) → 53,77 s (53,76);
  deszcz czyste okrążenia 9 → 64 (72), nowe rekordy 9 → 64 (72), zespoły z czasem 9 → 64 (69), okrążenia 187 → 182 (204), DNF 54 → 55 (70), najlepszy czas sesji 61,57 (6 ziaren) → 64,58 s (59,21). W deszczu część pierwszych rekordów pochodzi z okrążeń spowolnionych żółtą flagą (do 77 s); rekord tylko się poprawia, więc późniejsze szybsze okrążenia go zastępują. `npm run bench:step`: 495 → 480 µs/krok.
- Okrążenie z żółtą flagą w treningu (24.10.2026): auto, które w dowolnej chwili okrążenia miało `yellowFlag`, dostaje `yellow` w `LapFinishEvent` (z `Car.lapYellow`, zerowanego na starcie okrążenia). Okrążenie nadal się liczy (`lapsCount`, `lastLapTime`, rekord zespołu i globalny), ale nie uruchamia strażnika wydajności (powrót do `bestBrain`, czyszczenie bufora), nie zwiększa `stagnationCounter` (więc nie wywołuje `shakeBrain`) i nie rozstrzyga próby eksploracyjnej, jeśli nie jest nowym rekordem. Wcześniej okrążenie spowolnione cudzym wrakiem (70–80 s zamiast 56–60 s) karało model. Pomiar `scripts/diag-slow-laps.mjs 1200 <ziarno>` (ziarna 1–5, 20 aut, 14 generacji, średnio przed → po): najlepszy czas bez zmian, średni rekord zespołu 59,10 → 59,57 s, mediana czystych okrążeń 60,6 → 61,1 s, mediana wszystkich okrążeń 64,1 → 64,5 s, czyste okrążenia 168 → 144; gorzej w 4 z 5 ziaren. Prawdopodobnie strażnik wydajności cofał też sieci, które pogorszyły się same w trakcie uczenia, a żółta flaga obejmuje ok. 49% okrążeń treningowych (ok. 19 wraków na 100 okrążeń), więc ta ochrona działa teraz rzadziej. Skrót stanu `bench:step` zmienia się (inne uczenie).

## Uszkodzenia bez DNF z sumy i zjazd po nowe skrzydło (25.10.2026)

Pomiar `scripts/diag-damage.mjs` (GP, 20 aut, 3 ziarna, 942 okrążenia) przed zmianą: ok. 80 kontaktów auto–auto na 100 okrążeń z medianą prędkości zbliżenia ok. 2 m/s; kontakty poniżej 3 m/s dawały ok. 10% uszkodzeń. Suma uszkodzeń kończyła 28 z 69 wraków po zderzeniu aut (ostatni kontakt zwykle 3–8 m/s) i 27 z 39 wraków po uderzeniu w bandę. Teraz:
- kontakt poniżej 3 m/s nie uszkadza (`Car.CONTACT_DAMAGE_MIN_SPEED`);
- uszkodzenie zatrzymuje się na 1 i samo nie daje DNF, DNF daje tylko pojedyncze uderzenie od 12 m/s (`Car.addImpactDamage`);
- strategia boksu wzywa auto z uszkodzeniem od 0,5 (`PIT_DAMAGE_LIMIT` w `PitStrategy.ts`), tak samo w treningu, kwalifikacjach i wyścigu. Bez tego uszkodzone auta w treningu jeździły do respawnu z mniejszym dociskiem i typowe okrążenie wolniało (mediana 62,5 → 63,4 s).

Pomiar `scripts/diag-slow-laps.mjs 1200 <ziarno>` (ziarna 1–5, średnio przed → po): wraki łącznie 277 → 171 (po zderzeniu aut 114 → 58, banda 62 → 22, utknięcie 93 → 79), wraki na 100 okrążeń 17,8 → 10,8, okrążenia pod żółtą flagą 36,3% → 26,6%, okrążenia 315 → 325 na ziarno, mediana wszystkich okrążeń 62,5 → 62,7 s, p90 71,7 → 73,3 s (okrążenia z postojem), mediana czystych 60,4 → 60,6 s, średni rekord zespołu 58,48 → 58,39 s, najlepszy czas 54,72 → 54,23 s. Test nakładania się obrysów w `test-traffic` pomija auta w boksie i usunięte wraki, bo scena ich nie rysuje i nie mają bryły kolizyjnej. `npm run bench:step`: 661 µs/krok.

## Respawn w treningu nie przed nadjeżdżającym autem (25.10.2026)

Pole startowe uchodziło za wolne, gdy w promieniu 6 m nie stało żadne auto. Odrodzone auto, które startuje z miejsca, mogło więc pojawić się kilkanaście metrów przed autem jadącym 35–67 m/s i dostać w tył. Teraz pole jest wolne dopiero wtedy, gdy żadne żywe auto nie dojedzie do niego w ciągu 3 s (`Population.RESPAWN_CLEAR_SECONDS`, odległość wzdłuż trasy). Gdy nie ma wolnego pola, auto czeka poza torem jak dotąd. Dotyczy tylko respawnu w treningu, kwalifikacje i wyścig nie odradzają aut.

Pomiar `scripts/diag-slow-laps.mjs 1200 <ziarno>` (tor GP, 20 aut, ziarna 1–5, średnio przed → po): okrążenia pod żółtą flagą 43,1% → 36,3%, wraki na 100 okrążeń 18,9 → 17,8, mediana wszystkich okrążeń 64,2 → 62,5 s, p90 74,2 → 71,7 s, czyste okrążenia 31 → 41 na ziarno, mediana czystych 60,9 → 60,4 s, średni rekord zespołu 59,18 → 58,48 s, najlepszy czas bez zmian (54,72 s). Wraków po zderzeniu aut jest tyle samo (110 → 114 łącznie), bo najazdy na odrodzone auto były ich małą częścią. Większość to karambole aut, które wyjechały w tym samym zakręcie na żwir, oraz lekkie kontakty przy wyprzedzaniu, które dobijają auto z wcześniej zebranymi uszkodzeniami. `npm run bench:step`: 625 µs/krok.

## Wrak daleko od toru bez żółtej flagi (25.10.2026)

Wrak, który stoi dalej niż 5 m za krawędzią asfaltu (`YELLOW_EDGE_MARGIN` w `RaceTraffic.ts`), nadal jest fizyczną przeszkodą przez 15 s, ale nie tworzy lokalnej żółtej strefy. Tak kończy się większość utknięć (ponad 12 s poza asfaltem): mediana 15–27 m za krawędzią. Wraki po zderzeniu aut stoją zwykle na asfalcie, a po uderzeniu w bandę ok. 0,7 m za krawędzią, więc nadal dają żółtą flagę. Zasada działa tak samo w treningu, kwalifikacjach i wyścigu.

Pomiar `scripts/diag-slow-laps.mjs 1200 <ziarno>` (tor GP, 20 aut, ziarna 1–5, średnio przed → po): okrążenia pod żółtą flagą 48,5% → 43,1%, wraki na 100 okrążeń 19,0 → 18,9, mediana wszystkich okrążeń 64,5 → 64,2 s, p90 73,2 → 74,2 s, mediana czystych okrążeń 61,1 → 60,9 s, średni rekord zespołu 59,57 → 59,18 s, najlepszy czas 54,77 → 54,72 s. `npm run bench:step`: 632 µs/krok (skrót stanu się zmienia).

## Budżety planisty i hamowanie w zakręcie (25.10.2026)

Na Albert Park samotny ekspert jechał 1:53, a wytrenowana stawka ponad 2 minuty (rekord F1 ok. 1:20). Geometria toru się zgadza (5278 m, szer. 13 m). Planista zakładał jednak dużo mniej przyczepności, niż auto ma: `PLAN_CORNER_GRIP` 0,55 i `PLAN_BRAKE_GRIP` 0,40. Konfiguracja bolidu 2026 (docisk, moc, masa) zostaje bez zmian.

- `PLAN_CORNER_GRIP` 0,55 → 0,65, `PLAN_BRAKE_GRIP` 0,40 → 0,55.
- Hamowanie w zakręcie (`DrivePlanner`): opona, która już skręca auto, ma na hamowanie tylko resztę koła tarcia. Pedał eksperta ograniczony jest do `TRAIL_BRAKE_PEDAL · √(1 − u²) / skuteczność hamulców`, gdzie `u` to przyspieszenie boczne podzielone przez opóźnienie dostępne z opon, a `TRAIL_BRAKE_PEDAL` = 0,8 (udział przedniej osi przy granicy blokady). Bez tego większy budżet hamowania blokował koła (przy 0,65/0,55: 1,4 s blokady na 5 torach → 0,2 s).
- Siatka budżetów (samotny ekspert, `seedRandom(1)`, 3 okrążenia, suma najlepszych okrążeń na Albert Park, Monzy, Monako, Red Bull Ringu i Silverstone): 533 s przy 0,55/0,40, 470 s przy 0,65/0,55, ok. 465 s przy wyższych wartościach. Tam poślizgi i blokady gwałtownie rosną, więc wybrano 0,65/0,55.

| Tor (ekspert, najlepsze okrążenie) | przed | po |
|---|---|---|
| Albert Park | 113,2 s | 99,0 s |
| Monza | 107,1 s | 95,9 s |
| Monako | 102,8 s | 85,3 s |
| Red Bull Ring | 86,8 s | 78,3 s |
| Silverstone | 123,0 s | 111,5 s |
| GP (szer. 14 m) | 52,57 s | 51,78 s |

- Wytrenowana stawka, GP (`node scripts/bench-laptime.mjs 600 145,456,789`): najlepsze okrążenie 54,54 → 52,68 s, mediana rekordów 58,12 → 57,55 s, czas poza asfaltem 3,7% → 3,8%.
- Wytrenowana stawka, Albert Park (900 s treningu, 20 aut): najlepsze okrążenie 116,6 → 104,6 s, mediana wszystkich okrążeń 134,4 → 116,5 s, mediana czystych okrążeń 127,6 → 112,7 s, rekordy zespołów 121,8–142,0 → 106,2–121,0 s.
- Kalibracja opon (zalecenie z tej samej analizy) nie dała zysku. Mniejsze grzanie przodu (`TYRE_FRONT_HEAT`) albo całości (`TYRE_HEAT_SCALE`) spowalnia prawdziwe tory, bo ich opony i tak pracują poniżej optimum. Szersze okno temperatury nic tam nie zmienia. Model opon został więc bez zmian.
- Pozostała różnica do ok. 1:20 na Albert Park wynika z modelu auta: nasycenia siły bocznej (tanh), przyczepności ok. 2 g na płycie poślizgowej i wrażliwości opon na obciążenie. Druga przyczyna to luka między siecią a ekspertem.
- `scripts/test-pressure.mjs`: przy wyższych budżetach sieć częściej wypada na drugim okrążeniu. Test jeździ teraz do pierwszego czystego okrążenia, które ustala rekord (najwyżej 5 okrążeń). Skrót stanu `bench:step` się zmienia.

## Krzywizna linii bez szumu i gaz na wyjściu z zakrętu (25.10.2026)

- `LineProfile` liczył krzywiznę z krzywizny osi w pojedynczym punkcie (punkty co 1 m) plus poprawki linii. Milimetrowe nierówności po przepróbkowaniu toru dawały szum ±2–5 /km. W łuku Albert Park o promieniu ok. 450 m odczyt skakał między ok. 220 a 3900 m, a planista hamował na najciaśniejszym odczycie (277 → 259 km/h przy wykorzystaniu przyczepności ok. 50%). Teraz krzywizna osi i linii pochodzi z łuku `ARC_BASE` (6 m) wokół punktu. Uśrednianie trzech sąsiednich łuków spłaszczało szczyt nawrotów (Monako: 8,0 m zamiast ok. 5 m), więc go nie ma. Zygzak krzywizny z punktu na punkt na Albert Park (p99): 4,43 → 0,48 /km (`scripts/test-lines.mjs`).
- Szum działał jak ukryty zapas planisty. Bez niego kierowca regułowy częściej wypadał (czas poza asfaltem na 6 torach ok. 5 → 8,4 s), i to głównie na wyjściach z zakrętów: pełny gaz przy skręcie poniżej 0,35 zabierał tylnym oponom przyczepność potrzebną do skrętu i auto wynosiło na zewnątrz. Teraz przy obciążeniu bocznym powyżej 25% przyczepności gaz eksperta ograniczony jest do reszty koła tarcia tylnej osi: `EXIT_DRIVE_SHARE · 0,54 · a_opon · √(1 − u²)` podzielone przez przyspieszenie przy pełnej mocy ICE + MGU-K. `EXIT_DRIVE_SHARE` = 1,7, bo pełna moc rzadko jest dostępna (krzywa ICE na niskich obrotach, zwężanie ERS).
- Mniejszy budżet w ciasnych zakrętach (0,56–0,60 przy promieniu ≤ 30 m) i osobny, wyższy budżet dla części siły z docisku sprawdzono w tym samym skrypcie. Nie zmniejszały wypadnięć ani nie skracały okrążeń, więc ich nie ma.
- Kalibracja nagrzewania opon (`TYRE_HEAT_SCALE` 0,55–0,65, szersze okno temperatury) dawała ok. 1% na sumie torów. W zakrętach opony pracują w 99–132 °C (przyczepność 0,87–0,99), więc model opon został bez zmian.

Samotny ekspert (`seedRandom(1)`, 3 okrążenia, najlepsze okrążenie):

| Tor | 0,65/0,55 (wcześniej tego dnia) | krzywizna | krzywizna + gaz na wyjściu |
|---|---|---|---|
| suma 5 prawdziwych torów | 470,1 s | 456,7 s | 461,1 s |
| czas poza asfaltem (6 torów) | 5,0 s | 8,4 s | 4,1 s |
| GP | 51,78 s | 51,49 s | 52,40 s |

Wytrenowana stawka na Albert Park (900 s treningu, 20 aut, ziarna 145 / 456, przed → po): najlepsze okrążenie 104,6 → 101,8 s / 102,9 → 100,8 s, mediana wszystkich okrążeń 116,5 → 125,9 s / 117,0 → 118,2 s, mediana czystych okrążeń 112,7 → 116,6 s / 109,0 → 111,1 s, wraki na minutę 0,9 → 0,5 / 1,3 → 1,5. Najlepsze okrążenie się poprawia, a typowe nie: w 6–9 generacjach sieci nie doganiają szybszego nauczyciela, a rozrzut między ziarnami jest duży. Skrót stanu `bench:step` się zmienia.

## Szukanie tempa bez kary za okrążenia stresowe i wstrzyknięte błędy (26.10.2026)

Sesja treningowa z 2005 generacjami (tor 2639 m, presja 1, 15% okrążeń stresowych) pokazała zapadkę w `PaceSearch`: w gen. 1–3 najlepsze okrążenia 98,7–101 s, od gen. 4 już tylko ok. 110–112 s, mediana ok. 122 s do końca sesji. Wszyscy 20 kierowców mieli `margin` 0,90–0,92, czyli minimum (98,7 s × 1,12 ≈ 110,6 s). `fail()` odejmował 0,06 przy każdym wyjeździe, także na okrążeniach stresowych (−8% przyczepności, szum LIDAR) i po celowo wstrzykniętych błędach kierowcy, a odbijał się o ok. 0,01 na czyste okrążenie. Cofanie mózgów tego nie naprawiało, bo tempo planisty nie siedzi w sieci.

Teraz wyjazd lub rozbicie na okrążeniu stresowym (`Car.stressLap`) albo na okrążeniu z błędem kierowcy (nowa flaga `Car.lapIncident`) nie cofa marginesu. Okrążenia stresowe i błędy działają jak dotąd we wszystkich sesjach; zmienia się tylko to, z czego uczy się szukanie tempa, więc czasy okrążeń w treningu (i wynikający z nich `bestMargin` w wyścigu) się zmieniają. Dodatkowo nadzorca treningu (`src/ai/TrainingSupervisor.ts`) resetuje szukanie tempa, gdy przez 10 generacji co najmniej połowa stawki stoi przy minimum. Ponadto okrążenie uznawane jest za nieudane dopiero przy 3% straty do najlepszego (wcześniej 0,4 s). Losowe paliwo w treningu daje rozrzut kilku procent, więc niemal każde cięższe okrążenie cofało margines i zmniejszało krok do 0,01 na stałe. Krok rośnie znów ×1,25 po każdym lepszym okrążeniu (do 0,05). Trening na GP (20 aut, presja 1, 15% okrążeń stresowych, 40 gen., ziarna 145 / 456), gen. 21–40, przed → po samym wyłączeniu kary → po całości: mediana czystych okrążeń 60,76 → 60,70 → 60,32 s / 60,32 → 60,42 → 60,07 s, średni margines na końcu 0,908 → 0,915 → 0,946 / 0,907 → 0,911 → 0,929. Zysk jest mały (ok. 0,5% mediany), ale ten sam na obu ziarnach. Skrót stanu `bench:step` się zmienia.

## Aleja serwisowa (25.10.2026)

Wcześniej auto zjeżdżało do boksu na linii mety, znikało z toru i stało niewidoczne przez 20 s straty alei plus 2,5 s wymiany opon. Teraz:

- **Geometria** (`src/track/PitLane.ts`, budowana w konstruktorze `Track`): 130 m drogi wjazdowej, 260 m pod limitem 80 km/h i 60 m drogi wyjazdowej. Aleja leży na najprostszym odcinku w zasięgu ±500 m od linii mety (wraz ze 100 m za wyjazdem), więc auto wraca na prostą, a nie w zakręt. Na torze GP linia mety leży w łuku R76 z nawrotem za nim, dlatego aleja jest tam przesunięta. Szybki pas (5 m) biegnie za poboczem (najwyżej 6 m) i murkiem 1 m, po tej stronie, po której nie ma innego odcinka toru. Za nim, oddzielony białą linią, leży pas roboczy (6 m) z 10 stanowiskami zespołów co 18 m, a dalej garaże. Pole `pitLaneLoss` w plikach torów wczytuje się, ale już nie działa.
- **Przejazd:** auto wezwane do boksu skręca w aleję na linii PIT IN. Dalej jedzie kinematycznie po krzywej alei: hamowanie do 80 km/h przed linią limitu, limit, hamowanie 8 m/s² do swojego stanowiska, obsługa, ruszanie 6 m/s², za linią limitu 8 m/s² do wyjazdu. Hamowanie do stanowiska ma stałe opóźnienie kończące się dokładnie w punkcie postoju, a przecięcie linii wyjazdu jest interpolowane w kroku. Czas alei przy 30, 60 i 120 Hz różni się najwyżej o 2 kroki (`test-pitstops`). Auto w alei jest widoczne, ale nie bierze udziału w ruchu i nie widzą go czujniki aut na torze. Na stanowisko zjeżdża ukosem z szybkiego pasa (od 16 do 9 m przed stanowiskiem), a po obsłudze wraca na szybki pas (od 1 do 8 m za stanowiskiem). Auto na stanowisku nie blokuje szybkiego pasa: odstęp 8 m obowiązuje tylko między autami na tym samym pasie. Ekipa wypuszcza auto dopiero wtedy, gdy na szybkim pasie żadne auto nie nadjeżdża bliżej niż ok. 57 m z tyłu (droga rozpędzania do 80 km/h plus odstęp), więc nie ma niebezpiecznego wypuszczenia. Bramki sektorów i linia mety leżące przy alei liczą się przy mijaniu ich w alei. Na linii PIT OUT obowiązuje dotychczasowa reguła wolnego toru (12 m, 1,5 s). Auto wraca przy krawędzi toru z co najmniej 80 km/h, a planista łączy je z linią jazdy stopniowo.
- **Obsługa** (`serviceTime`, losowanie przez `random()`):
  - ekipa zespołu (`PIT_CREW_BASE`): wymiana kół 2,0–2,8 s plus rozrzut ±0,3 s;
  - uszkodzenie poniżej 0,1 jest naprawiane w czasie wymiany kół, 0,1–0,25 to szybka naprawa +1–3 s, od 0,25 wymiana nosa i skrzydła +6–9 s;
  - wpadka (koło, podnośnik) z prawdopodobieństwem 4%, a przy wymianie skrzydła 8%: +2–8 s;
  - podwójny postój: gdy partner z zespołu stoi na stanowisku albo do niego dojeżdża, auto czeka na pasie roboczym 8 m za nim.
- **Typowa strata:** przejazd alei na GP ok. 21 s (z obsługą ok. 2,3 s), z nowym nosem ok. 28 s; czekanie na wolny szybki pas wydłuża postój. `pitStopDuration(track)` szacuje go z geometrii (przejazd w limicie plus 2,4 s).
- **Widok:** nad autem w alei licznik `🔧 PIT 12,4 s` od linii wjazdu do linii wyjazdu. Po wyjeździe przez 5 s zostaje czas alei i postoju z dopiskiem „skrzydło”, „naprawa” albo „wpadka”. Panel wyścigu pokazuje najszybszy pit stop (najkrótszy czas alei, `RaceSession.fastestPitStop`).

Test ostatniego okrążenia w `test-race-finish` ma zaliczone dwie mieszanki: obowiązkowy zjazd na samym ostatnim okrążeniu kończył się teraz w alei, gdy wyścig zamykał limit czasu. Skrót stanu `bench:step` się zmienia.

## Poprawki z audytu fizyki (25.10.2026)

Audyt: `raport/2026-10-25/RAPORT.md`. Kalibracja: `npm run diag:nn -- 600`, ziarna 1–6, trening, 10 aut na GP; DNF na ziarno, średni rekord zespołów.

- **Ciągłość docisku przy zerowym wietrze.** Utrata docisku od kąta napływu powietrza (`CROSSWIND_DOWNFORCE_LOSS · sin²`) działała tylko przy niezerowym wietrze, więc w bezwietrznej pogodzie auto jadące bokiem miało pełny docisk, a wiatr 10⁻¹² m/s zabierał mu 60%. Kąt napływu liczy się teraz zawsze z prędkości względem powietrza; w bezwietrznej pogodzie to kąt znoszenia nadwozia. W normalnej jeździe (kilka stopni) strata jest poniżej 1%.
- **Balans na limicie.** Obie osie miały tę samą przyczepność na jednostkę obciążenia, a rozkład 46/54 dokładnie równoważył ramiona osi, więc auto było na limicie neutralne. Każdy transfer obciążenia do przodu (odpuszczenie gazu, hamowanie silnikiem) robił z niego auto nadsterowne: przy nasyceniu obu osi moment przodu przewyższał moment tyłu i nic nie zatrzymywało obrotu. Przy stałym nadmiernym skręcie przy 70 m/s auto obracało się do β ≈ 85° także bez gazu. Test „nadmierny skręt nie obraca auta” sprawdzał β dopiero po 5 s, gdy auto już stało, więc przechodził przypadkiem; teraz sprawdza największe β w całym przejeździe, także po odpuszczeniu gazu. `FRONT_GRIP_BIAS` 1,0 → 0,9 (później 0,89, patrz niżej): siła boczna przodu sięga 90% jego koła tarcia (elipsa), więc przód nasyca się pierwszy i auto na limicie jest podsterowne. Siła boczna przodu w użyciu jest zapisywana jako udział tej elipsy, więc rezerwa stabilności, budżet hamowania i blokada kół widzą nasycony przód jako nasycony (bez tego przód nigdy się nie blokował). Największe β przy 70 m/s: skręt 0,3 z gazem 1,06 → 0,29 rad, skręt 0,15 bez gazu 1,51 → 0,44 rad. Szczytowe przyspieszenie boczne bez poślizgu przy 70 m/s spada z ok. 3,6 do 3,2 g; wcześniejsza wartość obejmowała stan tuż przed obrotem.
- **Bilans energii ERS.** Przy odpuszczonym gazie bateria dostawała 105 kW × 88% bez siły hamującej: z pustym bakiem i bez pedałów suma energii kinetycznej i baterii rosła. Odzysk przy hamowaniu liczył się z pracy hamulców obu osi, choć MGU-K jest na tylnej, a ładowanie przy częściowym gazie i clipping pobierały moc także wtedy, gdy ICE jej nie dawał (zmiana biegu, ogranicznik obrotów). Teraz jeden helper (`harvest`) zamienia na ładunek najwyżej tyle pracy mechanicznej, ile bateria przyjmie (limit okrążenia i pojemność), i zwraca moc rzeczywiście pobraną. Przy odpuszczonym gazie MGU-K hamuje tylną oś siłą `P/v` w granicy jej koła tarcia. Przy hamowaniu odzysk jest ograniczony pracą tylnych hamulców i nie działa przy zablokowanym tyle. Ładowanie przy częściowym gazie i clipping są ograniczone bieżącą mocą ICE. Pełna bateria nie dodaje oporu. `test-neural-driving` sprawdza, że bez paliwa energia kinetyczna i baterii tylko maleje, a odzysk spowalnia auto. Na GP bateria kończy 600 s treningu z ok. 25% zamiast ok. 55%.
- **Siły skręconej przedniej osi.** Siła boczna przedniej osi działała w całości poprzecznie do nadwozia, choć kąt znoszenia uwzględniał skręt kół. Teraz w modelu dynamicznym siły przedniej opony (boczna `Fy` i wzdłużna `Fx` w układzie koła) są obracane o kąt skrętu `δ`: wzdłużnie `Fx·cosδ − Fy·sinδ`, poprzecznie `Fx·sinδ + Fy·cosδ`. Moment yaw liczy się z części poprzecznej. Skręcone koło hamuje więc auto w zakręcie, a hamowanie ze skrętem zmniejsza siłę skręcającą. W reżimie kinematycznym (poniżej 8–16 m/s) bez zmian. Dodatkowe opóźnienie w zakręcie przenosi obciążenie do przodu i część nadsterowności wraca, więc `FRONT_GRIP_BIAS` 0,9 → 0,89 (największe β przy 70 m/s, skręt 0,15 bez gazu: 0,61 → 0,53 rad; przy 0,9 test nie przechodzi). Sam ekspert na GP nie wypada częściej (2 ziarna po 300 s); więcej utknięć w kalibracji sieci mieści się w rozrzucie (por. wariant 0,9: 4,2, 0,88: 5,2 na ziarno).

| Etap | DNF auto–auto | DNF banda | DNF stuck | Średni rekord | Krok (`bench:step`) |
|---|---|---|---|---|---|
| Przed poprawkami | 2,0 | 1,5 | 3,2 | 58,35 s | 679 µs |
| Ciągłość docisku | 2,0 | 2,3 | 5,0 | 58,67 s | |
| + balans 0,9 | 1,0 | 0,5 | 2,2 | 56,22 s | 650 µs |
| + bilans ERS | 2,7 | 0,3 | 2,0 | 56,90 s | 642 µs |
| + siły skręconej przedniej osi | 2,3 | 0,5 | 4,3 | 57,28 s | 656 µs |

- **Liczniki w sekundach.** Czas bez zaliczonej bramki (`timeSinceCheckpoint`) rośnie o `dt`, a nie o 1 na krok. Eliminacja „stuck” następuje po `STUCK_TIMEOUT` = 10 s jazdy (30 s przy odzyskiwaniu kontroli), a powrót do bramki przed autem po wyjeździe poza tor jest możliwy po `REJOIN_MIN_TIME` = 0,5 s. Wcześniej przy 30/60/120 Hz eliminacja przychodziła po 20/10/5 s (`test-timing` sprawdza teraz wszystkie trzy). Przy 60 Hz zachowanie się nie zmienia, poza zaokrągleniem na granicy progu.
- **Ślady opon bez losowania.** Ślad powstawał z prawdopodobieństwem 0,28 na krok i zużywał `random()` symulacji, więc efekt wizualny przesuwał strumień losowań dla AI i zależał od częstotliwości kroku. Teraz ślad powstaje co `SKID_MARK_SPACING` = 2 m przebytej w poślizgu drogi (przy 60 Hz i ok. 30 m/s gęstość podobna jak wcześniej). Poślizg nie pobiera z `random()` (`test-neural-driving`). Skrót stanu `bench:step` się zmienia, bo zmienia się zużycie `random()`.

Sama ciągłość docisku zwiększała liczbę wypadnięć: obrócone auto nie dostawało już darmowego docisku i nie wracało na tor. Z podsterownym balansem auto rzadziej się obraca, więc wypadków jest mniej, a okrążenia są szybsze. Skrót stanu `bench:step` się zmienia.

## Ochrona przed wartościami nieskończonymi (19.10.2026)

Po całkowaniu, a przed przesunięciem auta, `updatePhysics` sprawdza stan dynamiczny: pozycję, prędkość, kurs, prędkość kątową, heave/pitch/roll z prędkościami, temperatury opon, ERS i paliwo. Wartość NaN lub ∞ zostałaby w stanie auta na zawsze, a pozycja NaN psuje też zapytania toru. Taki krok jest więc odrzucany. Pozycja zostaje ostatnią skończoną, zawieszenie wraca do statyki, złe wartości są resetowane, a auto kończy jazdę jak po uderzeniu w bandę (w treningu respawn po usunięciu wraku). Pierwsze takie zdarzenie trafia do `console.warn`. Test w `test-suspension`.

## Alokacje w kroku fizyki (19.10.2026)

Wyniki promieni (`rayDistances`, `rayHits`), udziały nawierzchni pod kołami i `currentControl` są nadpisywane w miejscu, bez tworzenia nowych obiektów co krok. Średnie lewych i prawych promieni liczone są bez `slice`. Odbiorcy kopiują te dane (wejścia sieci przez spread, snapshot workera przez structured clone). Wynik symulacji jest identyczny bit w bit: skróty stanu `bench:step` dla trzech ziaren się nie zmieniły, a `diag:nn` dla ziarna 1 daje ten sam wynik. Krok przyspieszył z ok. 537 do ok. 465 µs (−13%).

## Gorąca ścieżka kroku (23.10.2026)

- LiDAR: auta w zasięgu i ich układ (cos/sin kursu, połowa szerokości, położenie) liczone raz na skan, nie raz na promień; promień omija auto, którego okręgu opisującego nie przecina przed bieżącym trafieniem. Bufor aut i szumu LiDAR-u jest używany ponownie.
- Kontakty auto–auto: wczesne odrzucenie par, których środki nie zbliżą się w kroku na odległość, przy której bryły mogłyby się zetknąć.
- Sieć: `forward` zapisuje wejścia i aktywacje do buforów sieci (zwracana tablica jest nadpisywana przy następnym wywołaniu); `clone()` kopiuje wagi bez losowania nowych, które i tak były nadpisywane.
- Mistrz sesji wybierany jednym przejściem zamiast dwóch sortowań na krok; opona liczy się w polach auta bez krotki; trajektoria okrążenia przekazywana bez kopii; klasyfikacja wyścigu nie jest liczona w treningu.
- Wszystkie zmiany poza `clone()` dają identyczne skróty stanu `bench:step`. `clone()` przestał zużywać strumień `random()`, więc przebiegi z ziarnem są inne niż wcześniej (statystycznie równoważne).
- `npm run bench:step -- 60` (3 ziarna, na przemian przed/po): ok. 620 → ok. 520 µs na krok (−16%).

## Skrzynia 8-biegowa

- Przełożenia całkowite (bieg × przekładnia główna) maleją geometrycznie od 14,0 (1.) do 5,5 (8.) przy kole 0,36 m: 15 000 obr./min na 8. biegu to ok. 103 m/s (371 km/h). Dokument z `propozycje/` miał tabelę niezgodną z własnymi obrotami (bieg 8 ≈ 590 km/h), więc przełożenia policzono od nowa.
- Automat: wyższy bieg przy 13 500 obr./min, niższy przy 7 500 (z ochroną przed przekręceniem > 14 200), cięcie zapłonu 48 ms na zmianę w górę, odstęp 0,18 s, limiter 15 000, poślizg sprzęgła na starcie (silnik trzymany w paśmie mocy).
- Moc ICE = `ICE_POWER · gaz · f(obroty)`, gdzie `f` rośnie od 0,55 (4 000 obr./min, turbo-lag) do 1 przy 10 500 i dalej jest stałe (limit przepływu paliwa); to jedyny wpływ biegu na siłę napędową poza cięciem i limiterem.
- Hamowanie silnikiem po zdjęciu gazu: `(45 + 25·obroty/15000) Nm` przez aktualne przełożenie (nie jest „gazem”, więc nie łamie wyłączności pedałów).
- HUD pokazuje prawdziwy bieg i obroty, nie bieg wyliczany z prędkości.
- Wpływ na tempo: ok. 1,5% wolniejsze okrążenia (cięcia zapłonu, pasmo mocy, hamowanie silnikiem).

## Pacejka (usunięta 23.10.2026)

Wcześniej `Car.PACEJKA = true` podmieniał `tanh` siły osi na Magic Formula (`C=1,35`, `E=−0,85`, szczyt przy α≈7,5°, spadek ok. 15% za szczytem). Pomiar `npm run diag:nn` (3 ziarna po 600 s): 2–7 rozbić o bandę na ziarno (przy `tanh` 0) i niejednoznaczne czasy; 23.10.2026 z włączoną Pacejką nie przechodzi też `test-neural-driving` („overtaking left the asphalt”). Fizyka nie ma już przełączników, więc wariant usunięto (jest w historii gita). Wymagałby osobnego strojenia strażnika stabilności i planowanej przyczepności.

## Zawieszenie i prześwit (dynamiczne)

Stan po zmianach z 18.10.2026. Od 23.10.2026 wszystkie elementy poniżej działają zawsze, w treningu i w wyścigu; dawne przełączniki (`SUSPENSION_DYNAMIC`, `SUSPENSION_LOADS`, `SUSPENSION_ROLL`, `RIDE_HEIGHT_AERO`, `PLANK_CONTACT`, `PORPOISING`) i modele zastępcze usunięto.

- **Heave + pitch** (`Car.stepSuspension`): masa resorowana 0,85·m, bezwładność pitch 1,85·ms. Sprężyny osi 380/305 kN/m, prześwit statyczny 30/55 mm. Tłumiki asymetryczne: dobicie ζ = 0,5, odbicie ζ = 0,7. Wymuszenia to docisk przód/tył (46/54, z korektą śladu aero) i sprężysta część transferu wzdłużnego. Geometria zawieszenia przejmuje 50% transferu przy hamowaniu (`ANTI_DIVE`) i 30% przy przyspieszaniu (`ANTI_SQUAT`), więc 5 g hamowania obniża przód o < 6 mm. Częstotliwości ok. 5 Hz (heave) i 6,5 Hz (pitch). Podkroki 1/240 s, półjawny Euler, wynik niezależny od kroku symulacji (30/60/120 Hz, < 0,5 mm).
- **Obciążenia opon**: statyka plus siły sprężyn i tłumików, plus transfer geometryczny i masy nieresorowanej. Ruch nadwozia opóźnia część transferu. W bramce etapu 1 wariant z dawnym transferem quasi-statycznym miał ziarna z 54 i 19 uderzeniami w bandę, wariant z obciążeniami z zawieszenia nie.
- **Przechył**: sprężyny narożnikowe 145/115 kN/m i stabilizatory 45/46,5 kN/m. Stabilizatory dobrano tak, żeby przód przejmował ok. 52% ustalonego transferu bocznego, jak dawna stała. Tłumienie przechyłu ζ = 0,6 dzieli się na osie jak tłumiki heave. Transfer każdej osi wynika z momentu jej sprężyn i tłumików przechyłu, łącznie ze stanem przejściowym, i trafia do modelu wrażliwości opon. `rollAngle` i `pitchAngle` pochodzą teraz z dynamiki, więc przechył narasta z opóźnieniem względem przyspieszenia bocznego.
- **Przepływ pod podłogą**: aerodynamika widzi prześwit przez filtr 0,05 s (`FLOOR_FLOW_LAG`), który chroni próg zerwania przed migotaniem. `rideHeightLift` bez zmian: optimum przodu ok. 16 mm, tyłu ok. 35 mm, spadek do 75% poniżej 8/15 mm.
- **Deska**: przy prześwicie < 0 kontakt 3,5 MN/m i 85 kN·s/m. Siłę przejmuje podłoga zamiast opon, a tarcie deski 0,32·F działa jak dodatkowy opór. Poza asfaltem są garby: nowa wysokość co ok. 2,5 m drogi, amplituda trawa 6 mm, żwir 14 mm (`random()` ze ziarnem). HUD: „⚠ DOBIJANIE DESKI”.
- **Morświnowanie** (zawsze włączone od 23.10.2026, wcześniej domyślnie wyłączone): histereza przepływu. Zerwanie poniżej 8/15 mm, ponowne przylgnięcie dopiero powyżej 12/19 mm, strata 40% docisku (`PORPOISING_STALL_LOSS`). Przy podłodze pracującej przy progu zerwania (np. Cl·A ≈ 5 przy 80 m/s) daje to stabilny cykl ok. 3,5–4 Hz, ok. 3 mm rms przy każdym kroku symulacji. HUD: „⚠ MORŚWINOWANIE x Hz”.
- **Opóźnienie o jeden krok**: zawieszenie dostaje `longitudinalG`/`lateralG` z poprzedniego kroku (16,7 ms przy 60 Hz), bo przyspieszenia znane są dopiero po całkowaniu. To świadoma decyzja. Opóźnienie jest krótsze od relaksacji opony i od okresu przechyłu, a predykcja przyspieszenia mogłaby wzbudzić oscylacje między transferem a siłami opon.
- Na torze GP w treningu (vmax ok. 83 m/s) najniższy prześwit podłogi wynosi 12/30 mm. Progi zerwania nie są osiągane, a deska nie dotyka asfaltu ani pobocza, więc włączenie morświnowania na stałe nie zmieniło czasów (`test-timing`: 46,619 s przed i po). Oba zjawiska ujawnią się przy większym docisku lub wyższych prędkościach.

## Wejścia sieci kierowcy (rayCount + 13)

Do 5 dotychczasowych wejść (prędkość, prędkość kątowa, kąt do bramki, zakrzywienie, nadmiar prędkości) doszło 8 wejść stanu pojazdu: temperatura opon przód/tył (60–140 °C → 0–1), maks. zużycie, stan baterii ERS, bieg/8, obroty oraz prześwit przód/tył (0 przy desce na asfalcie, 1 przy 1,5 × prześwicie statycznym, od 18.10.2026). Prześwit wynika z jazdy, więc destylacja uczy go bez losowania. Zmienia to układ wejść, więc stare zapisane modele (i stary autozapis) są odrzucane — uczenie zaczyna od nowa. Worker odmawia wczytania sieci o innej liczbie wejść (`driverInputCount` w `Car.ts`).

Destylacja uczy te wejścia: nauczyciel jedzie z włączonym modelem opon i co 20 s (oraz po każdym respawnie) losowo zmienia temperaturę/zużycie opon i energię ERS; w połowie przypadków opony zostają w stanie nominalnym, żeby typowa jazda była odwzorowana precyzyjnie.

Autozapis zawiera teraz też energię ERS i stan opon (temperatury, zużycie) każdego kierowcy; klucz autozapisu uwzględnia liczbę wejść sieci.

## Wrażliwość opon na obciążenie

- Transfer boczny każdej osi pochodzi z modelu przechyłu (sprężyny, stabilizatory i tłumiki tej osi, patrz wyżej); w stanie ustalonym przód przejmuje ok. 52%.
- Tarcie koła skaluje się jak `(Fz/Fz_śr)^−k`, k = 0,12 (`LOAD_SENSITIVITY_EXP`). `Fz_śr` to średnie obciążenie koła danej osi. Dociążone koło zewnętrzne zyskuje mniej, niż traci wewnętrzne, więc przechył zmniejsza przyczepność osi. Oś, która przenosi większą część transferu, traci więcej (balans podsterowność/nadsterowność).
- Bez przechyłu oś ma nadal `μ·Fz`. Zależność przyczepności od prędkości i docisku pozostaje skalibrowana jak wcześniej. Model zastępuje dawną jednolitą karę ≤8%.
- Wersji ze stałym `Fz0`, w której μ maleje także z dociskiem, nie przyjęto. Szybsze okrążenie w wolnych zakrętach podwajało liczbę kontaktów w treningu. Wersja z k = 0,25 dawała ok. 48 uderzeń w bandę na 600 s (wcześniej 3).
- Działa zawsze (dawny przełącznik `LOAD_SENSITIVITY` usunięto). `diag:nn` przyjmuje `LSK=<k>` do badania wykładnika.

## Ślad aerodynamiczny: zasysanie i brudne powietrze

- `computeWake` (`src/physics/Traffic.ts`) w każdym kroku `Population.update` (także dla gracza) szuka aut przed bolidem: do 50 m wzdłuż trasy (`trackGap`), ślad o szerokości ±1,6 m z zanikiem gaussowskim.
- Zasysanie: opór × (1 − 0,3·s), pełny efekt tuż za tylnym skrzydłem, zanik do 50 m. Brudne powietrze: docisk × (1 − 0,2·s), zanik do 30 m. Siła śladu słabnie, gdy auto z przodu jest wolniejsze. Nie działa poniżej 20 m/s, w boksie i za wrakiem.
- Utracony docisk w 60% pochodzi z przedniego skrzydła (czysty rozkład to 46%), więc za rywalem auto jest bardziej podsterowne. Planista zakrętów zakłada bieżący docisk ze śladem.
- Od 23.10.2026 działa zawsze, w treningu tak samo jak w wyścigu (wcześniej tylko w wyścigu): model uczony w stawce trafia w wyścigu na to samo powietrze. Okrążenie treningowe może więc skorzystać z zasysania. HUD pokazuje „cień aero opór −x% docisk −y%”.

## Kontakt auto–auto: obrót i tarcie

- Impuls normalny jest przykładany w punkcie styku: środek między najbliższymi narożnikami lub ścianami obu obrysów. Uwzględnia masę i bezwładność `Iz = 1,3·m`, tak jak w modelu jednośladu. Tarcie styczne Coulomba μ = 0,3.
- Uderzenie poza osią obraca oba auta. Centralne najechanie od tyłu ich nie obraca. Prędkość kątowa po kontakcie jest ograniczona do max(1,2 rad/s, wartość przed kontaktem). Energia kinetyczna (liniowa i obrotowa) nie rośnie, co sprawdza `test:traffic`.
- Działa zawsze (dawny przełącznik `CONTACT_SPIN` usunięto).

## Kalibracja zmian z 18.10.2026 (`npm run diag:nn -- 600`, ziarna 1–6, trening)

| Wariant | DNF auto–auto / ziarno | DNF banda / ziarno | Średni PB zespołów |
|---|---|---|---|
| Przed zmianami | 4,7 | 3,0 | 64,8 s |
| Wrażliwość opon | 3,2 | 4,0 | 64,4 s |
| Obrót przy kontakcie | 5,8 | 2,7 | 64,8 s |
| Wszystko + ślad w treningu | 5,2 | 2,7 | 64,6 s |

Rozrzut między ziarnami jest duży (np. 0–10 DNF auto–auto), więc różnice poniżej ok. 1,5 DNF na ziarno mieszczą się w szumie. Obrót przy kontakcie zwiększa liczbę wtórnych kolizji, bo obrócone auto bywa staranowane. To skutek fizyki, nie błąd.

### Zawieszenie, etapy 1–4 (ta sama metoda, baseline = stan po zmianach powyżej)

| Etap | DNF auto–auto / ziarno | DNF banda / ziarno | Średni PB | Krok (`bench:step`) |
|---|---|---|---|---|
| Baseline | 7,5 | 4,5 | 64,80 s | 518 µs |
| 1: heave + pitch, obciążenia z zawieszenia | 4,7 | 4,0 | 64,50 s | 525 µs |
| 2: + przechył i stabilizatory | 4,0 | 3,3 | 63,73 s | 528 µs |
| 3: + deska i garby poza asfaltem | 3,8 | 5,2 | 63,88 s | 524 µs |
| 4: + morświnowanie (wyłączone; włączone daje to samo na GP) | 3,8 | 5,2 | 63,88 s | 536 µs |

Etap 2 przyspiesza okrążenie o ok. 1,2%. W stanie przejściowym tłumiki opóźniają transfer boczny, a planista zakrętów tego nie modeluje. Liczba wypadków przy tym nie rośnie.

Poprawka pól startowych (18.10.2026): na łuku boczne przesunięcie pola mogło postawić je za linią następnej bramki. Na torze GP 14 m dotyczyło to pola nr 9: 0,28 m za bramką 154. Auto nie mogło jej przeciąć, więc jego `currentCheckpointIdx` się nie zmieniał. Po ok. 150 m cel sterowania wypadał za autem, AI skręcało do oporu, a auto lądowało w żwirze lub na bandzie. Wynik to ok. 28 eliminacji „stuck” i kilka do kilkudziesięciu uderzeń w bandę na ziarno, zawsze to samo auto. `Track.getGridSlot` uznaje teraz takie bramki za już minięte. Test w `test-neural-driving` sprawdza 24 pola na trzech torach.

| Po poprawce pól startowych | DNF auto–auto / ziarno | DNF banda / ziarno | DNF stuck / ziarno | Średni PB |
|---|---|---|---|---|
| Przed poprawką (etap 4) | 3,8 | 5,2 | ok. 30 | 63,88 s |
| Po poprawce | 4,8 | 2,3 | 2,0 | 64,54 s |
