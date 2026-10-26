# F1 AI Simulator

Przeglądarkowy symulator wyścigów w TypeScript i Vite. Dwadzieścia bolidów (10 zespołów po 2 kierowców) korzysta z hybrydowego sterowania: geometrii toru, sensorów, sieci neuronowych i treningu online. Fizyka (płaska, w metrach) działa w Web Workerze, a strona rysuje tor, bolidy, pogodę i telemetrię w 3D przez Three.js (WebGL).

## Funkcje

- Ciągły trening AI bez restartowania sprawdzonych bolidów przy automatycznej zmianie generacji; ochrona modeli najlepszych okrążeń, import i eksport.
- Kwalifikacje do wyścigu według regulaminu F1 (opcja „Kwalifikacje do wyścigu” w panelu wyścigu): Q1 18 min (20 aut, odpada 5), Q2 15 min (15 aut, odpada 5), Q3 12 min (10 aut). Liczy się najlepsze pełne okrążenie sesji; okrążenie wyjazdowe nie jest mierzone, okrążenie z wyjazdem czterema kołami poza tor jest kasowane, auto bez ważnego czasu w Q1 lub Q2 zawsze odpada (także ponad zwykłą piątkę), okrążenie rozpoczęte przed flagą można dokończyć, a przy równych czasach wyżej jest kierowca, który uzyskał czas wcześniej. Reguła 107% jest oznaczana w wynikach (start z końca stawki za zgodą sędziów). Po Q3 wyniki pojawiają się w oknie, a wyścig startuje w kolejności kwalifikacji. Uproszczenia: auta wyjeżdżają z pól startowych co 1,5 s, paliwo jest uzupełniane do 20 kg na linii mety zamiast przerw w boksie, przerwy między sesjami trwają 10 s.
- Tabela czasów pokazuje 10 najlepszych z 20 aut; śledzony kierowca lub gracz spoza pierwszej dziesiątki pojawia się pod kreską z rzeczywistą pozycją.
- Wyścig Grand Prix z procedurą startową, flagą w szachownicę, klasyfikacją i postojami w alei serwisowej. Zwycięża pierwsze auto, które przejedzie dystans (najmniejszy czas wyścigu mierzony na linii). Po fladze każde auto kończy przy najbliższym przejeździe przez linię, także z okrążeniem straty („+N OKR”). Wyścig kończy się, gdy nikt już nie jedzie, albo po 1,5 ostatniego okrążenia zwycięzcy. Nie ma tankowania: auta startują z paliwem na cały dystans, a zbyt długi wyścig jest skracany do zasięgu baku. Auto zjeżdża do prawdziwej alei serwisowej z limitem 80 km/h, zjeżdża z szybkiego pasa na stanowisko swojego zespołu na pasie roboczym (nie blokuje innych) i jest przez cały czas widoczne. Ekipa wypuszcza auto, gdy szybki pas jest wolny. Nad autem liczy się czas od linii wjazdu do linii wyjazdu, a po wyjeździe przez 5 s widać czas alei i postoju. Czas obsługi zależy od ekipy zespołu, uszkodzeń (szybka naprawa albo nowy nos i skrzydło), losowych wpadek i podwójnego postoju partnerów. Panel wyścigu pokazuje najszybszy pit stop. Na suchym AI używa dwóch mieszanek i nie zjeżdża po zużyte opony na dwóch ostatnich okrążeniach. AI wybiera boczną linię wyprzedzania i omija wraki; lokalne żółte flagi ograniczają tempo i zabraniają wyprzedzania. Służby usuwają wrak 15 sekund czasu symulacji po wypadku lub zderzeniu (także w kwalifikacjach).
- Tory Grand Prix i owal, rysowanie własnej trasy oraz zapis i odczyt JSON. Automatyczne pobocza z trawy i żwiru, szersze po zewnętrznej stronie zakrętów, oraz bandy.
- Telemetria prędkości, przyspieszeń, paliwa, obciążeń osi, czasów, nawierzchni i przyczyny DNF.
- Rzadkie błędy hamowania lub skrętu AI w treningu i wyścigu; ochrona rekordowych sieci przed oceną takich okrążeń.
- Sterowanie gracza: WASD lub strzałki; P zgłasza postój.
- Profile obliczeniowe, pauza i przyspieszenie symulacji.
- „Diagnostyka AI” (przycisk w pasku sterowania albo klawisz L): pływające okno, które nie zatrzymuje treningu, kwalifikacji ani wyścigu. Odświeża się co sekundę tylko wtedy, gdy jest otwarte. Można je przeciągać i zmieniać jego rozmiar.
  - Przegląd: werdykt („Uczy się”, „Sieć uczy się jeździć sama”, „Plateau”, „Regres”, „Zapaść różnorodności”) i kluczowe wskaźniki. Najważniejszy z nich to udział kroków, w których strażnik poprawił sieć: gdy spada, sieć prowadzi coraz większą część okrążenia sama. Trend mediany to nachylenie prostej dopasowanej do ostatnich 10 generacji (ujemne oznacza szybciej). Okno pokazuje też skuteczność prób wyjścia ze stagnacji, różnorodność stawki (średnia odległość wag od mózgu mistrza) i wyspy. Dla bieżącej generacji podaje okrążenia czyste i nieoceniane, rekordy życiowe, cofnięcia mózgu, wypadki według przyczyny, korekty online i przyczyny interwencji.
  - Uwagi: automatyczne uwagi do wykresów, od najpoważniejszych. Każda mówi, od której generacji trwa objaw i co można zrobić: czasy idą w złą stronę, model zbłądził (generacje trzymają się daleko od rekordu sesji), postęp mieści się w szumie, tylko lider jest szybki, nauka na ślepo (prawie brak czystych okrążeń), jedzie strażnik zamiast sieci, dominuje jedna przyczyna interwencji, korekty online stoją, lawina wypadków, więcej cofnięć niż rekordów, nikt się nie poprawia, wyspy bez pożytku, zapaść lub spadek różnorodności, mutacja stoi, nasycone neurony i „nauka utknęła” (dalsze generacje nic nie dają). Kliknięcie uwagi pokazuje jej wykres; w zakładce Trendy uwagi stoją też pod wykresami. Etykieta zakładki podaje liczbę ostrzeżeń.
  - Nadzorca: po każdej generacji treningu czyta historię i reaguje na objawy, które Uwagi tylko opisują. Gdy co najmniej połowa stawki ma zapas tempa przy minimum, restartuje szukanie tempa. Gdy mutacja stoi przy maksimum, a próby eksploracji przegrywają, wraca do najniższej stopy mutacji. Gdy od 30 generacji nikt nie pobił swojego rekordu, każdy zespół dostaje referencję równą 20. percentylowi swoich ostatnich czystych okrążeń (rekord w tabeli zostaje), więc szczęśliwe okrążenie z początku sesji nie blokuje nauki. Gdy od 60 generacji nie ma rekordu sesji, trzy najsłabsze zespoły jadą próbę z krzyżówką mózgu mistrza i jednego z pięciu najszybszych (przegrana próba wraca do ich rekordu, mistrz jest nietykalny). Każdy rodzaj akcji odczekuje 30 generacji. Tryb „Automatycznie” wykonuje akcje sam, „Tylko sugestie” zostawia je z przyciskiem „Zastosuj”. Akcje trafiają też do logu sesji.
  - Trendy: wykresy po generacjach (czasy, interwencje według przyczyny, zdarzenia, różnorodność, mutacja) z odczytem wartości po najechaniu.
  - Kierowcy: sortowana tabela (rekord, okrążenia od rekordu, stopa mutacji, interwencje, tempo, linia, odległość od mistrza, wypadki). Kliknięcie wiersza wybiera auto.
  - Sieć: topologia i liczba parametrów mózgu mistrza, średnie |w| i nasycenie tanh w każdej warstwie.

  Przycisk pobierania w nagłówku okna zapisuje log całej sesji w JSON (`f1-diagnostyka-uczenia-gen…json`) do analizy, np. przez model AI: wszystkie zakończone generacje (wykresy przerzedzają historię po 400 generacjach, log nie), stan każdego kierowcy na koniec generacji, ustawienia sesji (tor, sieć, mutacja, paliwo, presja, wyspy, pogoda), werdykty, uwagi i opis znaczenia każdego pola z jednostkami.

  Statystyki to sama księgowość: nie zmieniają fizyki ani losowania. Nowa stawka, czysta tablica i reset czasów zaczynają je od zera.
- „Czysta tablica” (panel sterowania): po potwierdzeniu wszyscy kierowcy zapominają wszystko, czego się nauczyli (sieci, linie przejazdu, tempo, rekordy, generacje), autozapis jest usuwany, a trwająca sesja przerwana. Tor i ustawienia zostają; stawka startuje jak po pierwszym uruchomieniu.
- Wyspy treningowe (suwak w ustawieniach): dodatkowe Web Workery trenują w tle własne stawki na tym samym torze, na wolnych rdzeniach (np. rdzenie wydajnościowe Apple M1). Co 30 s czasu symulacji kierowca przejmuje model z wyspy tylko przy szybszym czystym okrążeniu, tej samej presji i tych samych wejściach sieci; przerwane tym okrążenie nie ocenia modeli. Jedna wymiana podmienia najwyżej ćwierć stawki (największe zyski najpierw), żeby stawki nie zbiegały jednocześnie do tych samych modeli. Wyspy stoją przy pauzie, w kwalifikacjach i w wyścigu. GPU nie jest używane: sieci są zbyt małe (ok. 2% czasu kroku), by zyskać na przesyłaniu danych do karty.
- Ochrona przed przeuczeniem:
  - Trudne okrążenia (suwak, domyślnie 25%): część okrążeń (w treningu, kwalifikacjach i wyścigu) jedzie się w losowych warunkach. Przyczepność wynosi od −8% do +3%, moc ±4%, a LIDAR widziany przez sieć ma szum i przesunięcie kalibracji. Planista o tym nie wie. Poprawki strażnika na tych okrążeniach uczą odporności. W treningu takie okrążenia nie ustanawiają rekordów i nie oceniają modeli, więc szczęśliwe warunki nie wygrywają selekcji. W kwalifikacjach i wyścigu ich czas i sektory liczą się normalnie.
  - Wyjście ze stagnacji: po 8 czystych okrążeniach bez rekordu kierowca przez jedno okrążenie jedzie silniej zmutowaną kopią rekordowej sieci. Jeśli pobije rekord, kopia zostaje. Jeśli nie, wraca sprawdzona sieć, więc rekord nigdy się nie pogarsza. Kolejne nieudane próby zwiększają krok mutacji, najwyżej do 12%.

## Fizyka

Model uwzględnia masę paliwa, moc i trakcję napędu, docisk, wektor oporu powietrza oraz wspólne koło tarcia dla sił opon. Szerokość toru jest wyrażona w metrach. Telemetria pokazuje przyspieszenie wynikające ze zmiany prędkości.

### Pogoda

Pogodę wybiera się w panelu wyścigu jako prognozę (`src/physics/Weather.ts`): słonecznie (stabilnie, punkt odniesienia kalibracji: powietrze 25 °C, tor 38 °C, bez wiatru), upał, pochmurno, silny wiatr, przelotny deszcz, deszcz, burza i zmienna. Pogoda działa w treningu, kwalifikacjach i wyścigu i zmienia się w czasie symulacji: chmury dryfują, a gdy zgęstnieją, pada deszcz. Słońce nagrzewa tor (w upale do ok. 55 °C), deszcz go chłodzi i moczy, a po opadzie słońce i ciepły asfalt go suszą. Wiatr ma średnią siłę i kierunek, porywy oraz wolno skręcający kierunek. Każdy wyścig i kwalifikacje zaczynają od prognozy z nowym ziarnem.

- **Temperatura toru i powietrza** wchodzą do bilansu cieplnego opon: na gorącym torze opony wychodzą z okna pracy i szybciej się zużywają, na zimnym wolniej się rozgrzewają.
- **Woda** obniża przyczepność slicków (patrz niżej). AI zjeżdża po intery lub deszczówki, gdy zacznie padać, i wraca na slicki, gdy tor przeschnie.
- **Wiatr** zmienia prędkość względem powietrza: wiatr czołowy 8 m/s obniża prędkość maksymalną z ok. 310 do 290 km/h, w plecy podnosi ją do ok. 327 km/h. Wiatr boczny zabiera docisk (najbardziej przedniemu skrzydłu), pcha bolid w bok i skręca go, a porywy zmieniają te siły w czasie.
- **Gęstość powietrza** zależy od jego temperatury: zimne powietrze daje więcej docisku i oporu, gorące mniej (25 °C to punkt kalibracji). Wiatr przyspiesza wysychanie toru.
- **Aquaplaning**: slicki na stojącej wodzie powyżej 200 km/h tracą przyczepność.
- **Hamulce** mają temperaturę tarcz (zimne i przegrzane hamują słabiej) i mogą zablokować koła, bo bolid nie ma ABS: pełny pedał w zakręcie blokuje przód, auto jedzie prosto i dostaje płaskie miejsce na oponie.

W treningu okrążenia porównuje się w obrębie jednej klasy warunków (sucho / wilgotno / mokro). Okrążenie, na którym warunki wyszły poza klasę sesji, liczy się do czasu, ale nie ocenia sieci. Pierwsze czyste okrążenie w nowych warunkach ustala nowy rekord odniesienia, a sprawdzony mózg zostaje. Wyspy treningowe mają własną pogodę z tej samej prognozy i wymieniają tylko modele z tych samych warunków. Sieć nie dostała nowych wejść, więc zapisane modele nadal się wczytują.

W 3D chmury przełączają niebo na pochmurne (powyżej 65% zachmurzenia, z powrotem poniżej 55%, żeby niebo nie migotało) i przygaszają słońce, deszcz pada wokół kamery i jest znoszony przez wiatr, mokry asfalt ciemnieje i błyszczy, a bolidy ciągną za sobą pióropusz wody. Dym i spray znosi wiatr. Telemetria pokazuje pogodę, temperatury, wiatr ze strzałką kierunku i stan nawierzchni.

### Opony i nawierzchnia

W wyścigu i kwalifikacjach bolidy jeżdżą na pięciu mieszankach (`src/physics/Tyres.ts`): Soft (S, czerwona), Medium (M, żółta, punkt odniesienia kalibracji), Hard (H, biała), Intermediate (I, zielona) i Wet (W, niebieska). Mieszanka zmienia szczytową przyczepność (soft +3,5%, hard −3%, intery −12% i deszczówki −18% na suchym), okno temperatury pracy (95 / 100 / 108 / 80 / 70 °C) i tempo zużycia (×1,8 / ×1 / ×0,6 / ×2,6 / ×3,4). Wilgotność toru wynika z pogody. Woda obniża przyczepność slicków do ~45% na mokrym, chłodzi opony i zmniejsza zużycie. Intery są najszybsze na wilgotnym torze, deszczówki w ulewie. W treningu bolid dostaje opony właściwe dla warunków przy resecie i zjeżdża po nie, gdy warunki się zmienią.

AI startuje na mieszance zależnej od pola startowego (medium / soft / hard) albo na oponach dobranych do pogody. W boksie zmienia slicki (na hard, z hard na medium), a gdy nawierzchnia zmieni się w trakcie wyścigu (deszcz, przesychanie), zjeżdża po opony właściwe dla warunków. Gracz wybiera swoją mieszankę na start i na każdy pit stop. Mieszankę widać w tabeli wyników i telemetrii, a w 3D jako kolorowy pasek na boku opony.

To model hybrydowy do gry: jednoślad z kątami znoszenia, dynamiczne zawieszenie, opony, hamulce, ERS i aerodynamika ze śladem, kontakty auto–auto z obrotem. Osiągi nie są kalibrowane względem konkretnego bolidu F1. Szczegóły, stałe i ograniczenia opisuje [PHYSICS.md](PHYSICS.md).

### Te same zasady w treningu i w wyścigu

Trening, kwalifikacje i wyścig mają tę samą fizykę i te same warunki: pogodę, gęstość powietrza, opony (temperatura, zużycie, mieszanki, aquaplaning), hamulce (temperatura, blokowanie kół), ślad aerodynamiczny, morświnowanie, aleję serwisową i brak tankowania. Tak samo zachowują się auta w walce i po wypadku: rozbite auto zostaje 15 s wrakiem z lokalną żółtą flagą, kierowcy atakują, jadą w cieniu na prostej, bronią wewnętrznej i wyprzedzają, a „trudne okrążenia” (patrz wyżej) zdarzają się w każdej sesji. Nie ma przełączników wyłączających mechanikę, więc model nauczony w treningu trafia w wyścigu na te same warunki (`npm run test:parity`).

Celowo różnią się tylko mechanizmy uczenia i zasady sesji, nie warunki jazdy:
- uczenie tylko w treningu: DAgger i bufor próbek, mutacje przy respawnie i sam respawn po usunięciu wraku, ewolucja generacji, poszukiwanie linii i tempa (`LineSearch`, `LineNet`, `PaceSearch`), próby wyjścia ze stagnacji, wyspy treningowe;
- księgowanie rekordów: w treningu trudne okrążenie i okrążenie poza klasą warunków nie oceniają modelu, a zmiana warunków resetuje rekord odniesienia; w kwalifikacjach i wyścigu takie okrążenia mają ważny czas i sektory. Odwrotnie z walką i żółtą flagą: w wyścigu okrążenie z atakiem, wyprzedzaniem lub pod żółtą flagą nie jest wzorcowe, a w treningu (gdzie stawka walczy prawie stale) nadal ocenia model; w każdej sesji unieważnia je kontakt, uszkodzenie i wyjazd poza tor;
- wybór sprawdzonego zamiast próbnego marginesu tempa i linii w kwalifikacjach i wyścigu (w treningu jedzie się próbę, którą ocenia okrążenie);
- paliwo: wyścig startuje z paliwem na dystans, kwalifikacje dolewają do 20 kg na linii, a trening przy respawnie losuje paliwo z zakresu wyścigowego (5 kg – paliwo na 50 okrążeń).

Szczegóły i pomiar wpływu: `PHYSICS.md`, sekcja „Trening = wyścig”.

Po zmianie fizyki z 04.10.2026 dawne rekordy i modele AI wymagają ponownego treningu. Od 26.10.2026 wyjazd na okrążeniu stresowym albo po wstrzykniętym błędzie kierowcy nie obniża zapasu tempa planisty, okrążenie wolniejsze o mniej niż 3% (rozrzut z losowego paliwa) nie cofa go do sprawdzonego, a nadzorca treningu może zmieniać referencje zespołów, stopę mutacji i uruchamiać próby z krzyżówką mistrza, więc czasy i przebieg treningu się zmieniają (w długich sesjach zapas tempa nie zjeżdża już całej stawce do minimum). Zapisane modele wczytują się bez zmian. Od 25.10.2026 (poprawki z audytu fizyki) auto jadące bokiem traci docisk także w bezwietrznej pogodzie, a na limicie przyczepności jest lekko podsterowne zamiast nadsterownego, więc rzadziej się obraca. Odzysk energii ERS przy odpuszczonym gazie hamuje teraz auto, a przy hamowaniu pochodzi tylko z tylnej osi, więc bateria nie ładuje się już za darmo i jest średnio mniej naładowana. Skręcone przednie koła hamują teraz auto w zakręcie. Na GP wypadków na bandzie i z innymi autami jest mniej, rekordy zespołów są szybsze o ok. 1 s, więc dawne rekordy nie są porównywalne. Zapisane modele wczytują się bez zmian, ale warto je douczyć. Od 25.10.2026 postój to przejazd prawdziwej alei serwisowej (na GP ok. 21 s, z nowym nosem ok. 28 s) zamiast stałych 22,5 s na linii mety, a czas obsługi zależy od zespołu, uszkodzeń i wpadek. Czasy okrążeń z postojem i przebieg wyścigu się zmieniają. Pole `pitLaneLoss` w plikach torów nadal się wczytuje, ale nie ma już znaczenia. Od 25.10.2026 MGU-K oddaje tylko moment, który przeniosą tylne opony, i pełne 350 kW od 40% baterii. Bolid przyspiesza więc szybciej powyżej ok. 150 km/h (0–200 km/h 4,9 → 4,7 s, 0–300 km/h 11,7 → 8,4 s), a czasy okrążeń i zachowanie baterii się zmieniają. Zapisane modele wczytują się bez zmian. Od 25.10.2026 kierowca regułowy (nauczyciel sieci) zakłada więcej przyczepności w zakręcie i przy hamowaniu, a w zakręcie hamuje lżej. Ekspert jest szybszy o ok. 9–17% (Albert Park 1:53 → 1:39), a wytrenowana stawka na GP o ok. 1–3%. Dawne rekordy nie są porównywalne, a zapisane modele warto douczyć. Tego samego dnia planista czyta promień zakrętów bez szumu punktów toru (nie hamuje już w szybkich łukach bez potrzeby), a na wyjściu z zakrętu dawkuje gaz według przyczepności tylnych opon, co znów zmienia czasy okrążeń. Od 25.10.2026 wrak stojący dalej niż 5 m od asfaltu nie wywołuje żółtej flagi, więc w stawce jest mniej okrążeń spowolnionych żółtą (ok. 49% → 43% w treningu na GP), a czasy okrążeń w treningu i wyścigu nieco się zmieniają. Tego samego dnia respawn w treningu czeka, aż żadne auto nie dojedzie do pola startowego w ciągu 3 s, co skraca typowe okrążenie treningowe na GP o ok. 1,5 s. Od 25.10.2026 kontakt poniżej 3 m/s nie uszkadza auta, suma uszkodzeń nie daje DNF (tylko uderzenie od 12 m/s), a AI zjeżdża do boksu z uszkodzeniem od 0,5. Wraków jest o ok. 38% mniej, więc przebieg treningu i wyścigu się zmienia. Od 24.10.2026 okrążenie treningowe spowolnione żółtą flagą nadal się liczy, ale nie cofa modelu do rekordowego i nie nalicza stagnacji, więc czasy w treningu mogą się nieco zmienić. Od 24.10.2026 tory mają punkty co 1 m zamiast co 18 m (gładkie zakręty w obrazie i w fizyce, patrz `PHYSICS.md`). Zakręty mają teraz prawdziwy, często ciaśniejszy promień, więc czasy okrążeń się zmieniają, a dawne rekordy nie są porównywalne. Pliki torów i modeli wczytują się bez zmian. Zapamiętane profile linii są budowane od nowa. Rekalibracja nagrzewania opon z 24.10.2026 (opony znów pracują w oknie ok. 85–110 °C zamiast ok. 130 °C) skraca okrążenie o ok. 2–3 s, więc dawne rekordy nie są porównywalne. Zapisane modele wczytują się bez zmian. Tego samego dnia prawdziwe tory dostały gęste, wygładzone punkty (pole `pointSpacing`), a linia jazdy otwiera ciasne łuki: najwolniejsze zakręty są szybsze (mediana minimalnej prędkości eksperta 38 → 57 km/h), okrążenia krótsze średnio o ok. 7%, a zapamiętane profile linii budują się od nowa. Pliki torów bez `pointSpacing` (własne i dawne eksporty) wczytują się jak dotąd. Płynny skręt z 24.10.2026 (dwustopniowe opóźnienie kół, dłuższy cel kierowcy regułowego przy dużej prędkości) zmienia czasy okrążeń, więc dawne rekordy nie są porównywalne. Układ wejść się nie zmienił, więc zapisane modele się wczytują, ale warto je douczyć, bo uczyły się od drgającego nauczyciela. Zmiany z 23.10.2026 (zużycie paliwa według limitu 100 kg/h, postoje bez tankowania ze stratą alei, ślad aerodynamiczny i morświnowanie także w treningu, gęstość powietrza z temperatury, aquaplaning, temperatura hamulców i blokowanie kół) znów zmieniają czasy okrążeń i przebieg treningu, więc dawne rekordy nie są porównywalne. Układ wejść sieci się nie zmienił, więc zapisane modele się wczytują, ale warto je douczyć. Zmiana ERS na regulamin 2026 (13.10.2026) ponownie zmienia czasy okrążeń, więc dawne rekordy nie są porównywalne. Pliki modeli z 10 kierowcami nadal się wczytują: drugi kierowca zespołu dostaje lekko zmutowaną kopię sieci partnera. Droga hamowania i czasy okrążeń zmieniły się wraz z poprawą limitów tarcia i skali drogi.

## Uruchomienie

Wymagany Node.js 20.19+ albo 22.12+ (zgodnie z wymaganiami Vite) i npm.

```bash
npm ci
npm run dev
```

Vite wyświetli lokalny adres aplikacji, domyślnie `http://localhost:5173`.

```bash
npm test               # regresje fizyki, wyścigu, treningu, poboczy i pomyłek
npm run test:units     # szybkie testy jednostkowe: przyczepność mieszanek, wybór opon, LiDAR
npm run test:learning  # ochrona wiedzy AI i zmiany generacji
npm run test:stats     # diagnostyka uczenia: liczniki generacji, trendy, werdykty, uwagi, log sesji
npm run test:supervisor # nadzorca treningu: szukanie tempa, wykrywanie objawów, odstępy, tryb sugestii, selekcja
npm run test:qualifying # zasady Q1–Q3, siatka startowa
npm run test:islands   # wyspy treningowe: przenoszenie toru i reguły wymiany modeli
npm run test:parity    # trening = wyścig: wrak i żółta flaga 15 s, holowanie, obrona, atak, trudne okrążenia, paliwo
npm run test:robustness # trudne okrążenia, próby wyjścia ze stagnacji, limit migracji
node scripts/bench-laptime.mjs 1800 145,456,789 # pomiar postępu nauki (ok. 15 min)
npm run bench:step     # przepustowość fizyki: µs na krok i skrót stanu (do porównań po optymalizacjach)
npm run test:runoff    # pobocza, bandy, powrót na asfalt i pomyłki AI
npm run audit:physics  # wyniki prób numerycznych
npm run lint           # oxlint (błędy poprawności, nieużywane zmienne)
npm run build          # TypeScript i produkcyjne dist/
npm run preview        # podgląd zbudowanej wersji
npm run test:tracks    # wszystkie tory z tracks/ (ok. 20 min)
```

CI (`.github/workflows/ci.yml`) przy każdym pushu i pull requeście uruchamia `tsc --noEmit`, `npm run lint`, `npm test` i `npm run build`; `npm run test:tracks` biegnie co noc.

## Struktura

- `src/main.ts` — strona: panele, przyciski, pętla renderowania; `src/ui/` — synchronizacja ze snapshotami workera (`SnapshotSync`), ekrany wyścigu i kwalifikacji (`RaceUI`), klawiatura (`InputController`), okno diagnostyki uczenia (`LearningPanel`, wykresy w `charts.ts`).
- `src/workers/` — `sim.worker.ts` (symulacja i protokół wiadomości), `island.worker.ts` (wyspy treningowe), `CarView.ts` (wspólny schemat stanu auta w snapshocie), `SimBridge.ts`.
- `src/physics/` — `Car.ts` (dynamika, opony, hamulce, ERS, paliwo, obrys), `DrivePlanner.ts` (planista i strażnik), `LapTiming.ts` (pomiar okrążeń i sektorów), `PitStrategy.ts` (postoje), `Fitness.ts` (nagrody), `Traffic.ts` (kontakty, ślad aero), `Weather.ts`, `Tyres.ts`, `SimConfig.ts` (pogoda i ustawienia symulacji).
- `src/race/RaceSession.ts` — kwalifikacje, start, wyścig, szachownica i klasyfikacja (czysty moduł, testowany bez workera).
- `src/ai/` — sieci neuronowe, populacja, linie przejazdu, wyspy, taktyka wyścigowa, statystyki uczenia (`LearningStats.ts`), uwagi do wykresów (`LearningInsights.ts`), nadzorca treningu (`TrainingSupervisor.ts`) i log sesji do pobrania (`LearningLog.ts`).
- `src/track/`, `src/math/` — geometria, presety, spline i wektory.
- `src/rendering/three/` — scena Three.js: `SceneRenderer` (scena, światło, pogoda), `TrackMesh`, `CarFleet`, `Cameras`, `Effects`/`Particles`/`Rain`, `Labels`, `Overlays`, `Hud`; `src/rendering/HudCharts.ts` — wykresy telemetrii, `MotionInterpolator.ts` — płynny ruch między snapshotami.
- `scripts/` — testy regresyjne (`npm test`), benchmarki i diagnostyka.

## Dokumentacja

- [Aktualny model fizyki](PHYSICS.md).
- `docs/archive/` — historyczne audyty i analizy ([audyt fizyki przed naprawami](docs/archive/AUDIT_PHYSICS.md), [audyt aplikacji](docs/archive/AUDIT.md), audyty z 19.10.2026, analizy fizyki) oraz archiwalne opisy wcześniejszej implementacji (`opis.md`, `opis.txt`).
- `propozycje/` — propozycje zmian modelu (część wdrożona, patrz PHYSICS.md).

Projekt pierwotnie rozwijano przy użyciu Gemini Antigravity.

Widok toru: przyciski +/− lub kółko myszy zmieniają zoom (25–800%). Przeciągnięcie przesuwa widok i wyłącza śledzenie. „Cały tor” dopasowuje trasę do okna. Wybierz zawodnika w tabeli lub kliknij auto, następnie włącz „Śledź zawodnika”; kamera podąża za wybranym autem także po zmianie generacji. Bez wcześniejszego wyboru przycisk wybiera aktualnego lidera.

Wyjazd poza asfalt nie eliminuje bolidu: trawa zmniejsza przyczepność, a żwir dodatkowo wyhamowuje ruch. Lekki kontakt z bandą wygasza ruch w jej kierunku i zmniejsza prędkość wzdłuż bandy. Uderzenie z prędkością prostopadłą co najmniej 12 m/s powoduje DNF w wyścigu. W treningu auto też zostaje 15 s wrakiem z żółtą flagą, a dopiero po jego usunięciu wraca na tor. Samochód zatrzymany głęboko w żwirze może ugrzęznąć i zakończyć jazdę z powodu braku postępu.

### Poszukiwanie linii przejazdu

Kierowcy rozpoczynają trening z różnymi profilami trajektorii. Profil określa przesunięcie na prostej, wyprzedzenie wejścia w zakręt, głębokość dojścia do wierzchołka i wyjście. Docelowe przesunięcie zależy od lokalnej i przewidywanej krzywizny; nie jest stałą jazdą środkiem ani jednym pasem wokół całego toru. Kontroler płynnie realizuje trajektorię, zachowując ograniczenia asfaltu, przyczepności i ruchu innych aut.

Po czystym okrążeniu kierowca porównuje mediany ostatnich maksymalnie pięciu czasów dla profilu. Najpierw sprawdza profile początkowe, następnie regularnie generuje nowe próby wokół najlepszego. Okrążenie przejściowe po zmianie profilu i okrążenia zakłócone incydentami lub wyprzedzaniem nie oceniają profilu. Najlepszy profil pozostaje chroniony podczas mutacji. W wyścigu kierowca korzysta z najlepszego sprawdzonego wariantu. Wyniki poszukiwania pozostają przy bolidzie podczas indywidualnego respawnu i automatycznych zmian generacji.

Główną linię wyznacza sieć linii (`src/ai/LineNet.ts`) z korektą przesunięcia dla każdego z 16 odcinków toru. Cykl nauki każdego kierowcy:
- **korekta odcinków:** przesunięcie 1–2 odcinków jest oceniane przez 2 okrążenia; zostaje, gdy suma czasów trzech odcinków, na które wpływa (łącznie z wyjściem), spadła o co najmniej 0.04 s;
- **kandydat sieci:** zmutowana sieć zostaje, gdy średnia z 2 okrążeń jest lepsza od czasu mistrza;
- **ponowny pomiar mistrza:** raz na cykl, bo czasy okrążeń są zaszumione.

Szybsza linia trafia do partnera z zespołu jako kandydat. Partner przyjmuje ją tylko wtedy, gdy u niego też jest szybsza.

Planer hamowania liczy bezpieczną prędkość z promienia linii, którą auto naprawdę jedzie (`src/ai/LineProfile.ts`), a nie z osi toru. Szeroki łuk po zewnętrznej–wierzchołku–zewnętrznej daje więc wyższą planowaną prędkość w zakręcie. Nagroda za punkt kontrolny nie zależy od odległości od środka toru.

`node scripts/bench-laptime.mjs [sekundy] [ziarna]` trenuje stawkę bez interfejsu i podaje:
- najlepszy czas,
- medianę rekordów kierowców,
- typowe tempo z końca treningu (`lateMedian`),
- wykorzystanie szerokości toru,
- prędkość w zakrętach,
- czas poza asfaltem.

Wyniki są powtarzalne dla tych samych ziaren. Typowe okrążenie w ruchu 20 aut jest o kilka sekund wolniejsze od rekordu kierowcy, a różnice między ziarnami sięgają ±1.5 s. Do porównań trzeba więc kilku ziaren i co najmniej 1800 s treningu.

Jest to ograniczone poszukiwanie ewolucyjne parametrów trajektorii, współpracujące z istniejącym uczeniem sterowania; nie gwarantuje globalnego optimum. Zmiany paliwa i warunków ruchu mogą nadal wpływać na porównanie czasów. `node scripts/test-lines.mjs` sprawdza dobór profilu, ochronę najlepszego wariantu, nowe mutacje oraz przebieg zewnętrzna–wierzchołek–zewnętrzna.

### Presja kierowców

Suwak „Presja kierowców” działa w treningu i wyścigu, od −10 (większy zapas) przez 0 (dotychczasowe tempo) do +10 (jazda blisko granicy). Ustawienie zapamiętuje się lokalnie. Podczas jazdy decyzje zmieniają się płynnie przez dwie sekundy czasu symulacji; bolidy i modele nie są restartowane. Telemetria pokazuje aktualną presję i kierunek zmiany. Żółte flagi, omijanie ruchu i odzyskiwanie kontroli mają pierwszeństwo. Ręczne sterowanie nie zależy od suwaka.

Presja zmienia planowaną przyczepność zakrętów (32% / 45% / 75%), przewidywane hamowanie (0,85 / 1 / 1,80), częstość ataków (0,5 / 1 / 2) i częstość pomyłek (0,25 / 1 / 4) odpowiednio przy −10 / 0 / +10. Przy +10 punkt hamowania jest późniejszy, minimalny nacisk AI na hamulec spada z 65% do 45%, a strefa wcześniejszego odpuszczania gazu zwęża się z 0,15 do 0,02 jednostki znormalizowanego nadmiaru prędkości. Nie oznacza to ograniczenia mocnego hamowania w sytuacji zagrożenia. +10 świadomie dopuszcza większe ryzyko; kierowca nie jest automatycznie spowalniany tylko po to, aby zmniejszyć liczbę DNF. Wartości pośrednie są interpolowane. Rzeczywiste siły hamulców i przyczepność opon pozostają niezmienione. Ryzyko pomyłki zależy od wykorzystania przyczepności i czasu symulacji; nie jest zwiększane pod żółtą flagą, przy postoju, zjeździe do boksu ani podczas odzyskiwania kontroli.

Poszukiwanie linii przejazdu przechowuje niezależne wyniki dla każdego z 21 ustawień w bieżącej sesji. Powrót do presji przywraca jej profile. Okrążenie obejmujące zmianę presji liczy się czasowo, ale nie ocenia profilu, nie nadpisuje modelu i nie zapisuje próbek uczenia; uczenie wraca od początku kolejnego pełnego okrążenia po zakończeniu przejścia. Rekordy i eksportowane modele zawierają presję pomiaru (stare pliki przyjmują 0). W tabeli `P +5` oznacza presję podczas rekordu. Wolniejszy wynik przy innym ustawieniu nie uruchamia cofania sieci do rekordowego modelu.

`npm run test:pressure` porównuje −10, 0 i +10 na tych samych modelach, torze oraz trzech zestawach losowania. `node scripts/test-pressure.mjs --full --high-only` sprawdza +10 w pełnej stawce dziesięciu bolidów przez dziesięć okrążeń. Testy mierzą ukończenia, DNF, czasy, wykorzystanie przyczepności, poślizgi, pobocza i pomyłki. Są to wyniki powtarzalnych scenariuszy testowych, a nie gwarancja ukończenia każdej losowej sesji.
