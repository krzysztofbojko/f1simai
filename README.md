# F1 AI Simulator

Przeglądarkowy symulator wyścigów 2D w TypeScript i Vite. Dwadzieścia bolidów (10 zespołów po 2 kierowców) korzysta z hybrydowego sterowania: geometrii toru, sensorów, sieci neuronowych i treningu online. Fizyka działa w Web Workerze, a interfejs renderuje tor i telemetrię przez Canvas 2D.

## Funkcje

- Ciągły trening AI bez restartowania sprawdzonych bolidów przy automatycznej zmianie generacji; ochrona modeli najlepszych okrążeń, import i eksport.
- Kwalifikacje do wyścigu według regulaminu F1 (opcja „Kwalifikacje do wyścigu” w panelu wyścigu): Q1 18 min (20 aut, odpada 5), Q2 15 min (15 aut, odpada 5), Q3 12 min (10 aut). Liczy się najlepsze pełne okrążenie sesji; okrążenie wyjazdowe nie jest mierzone, okrążenie z wyjazdem czterema kołami poza tor jest kasowane, auto bez ważnego czasu w Q1 lub Q2 zawsze odpada (także ponad zwykłą piątkę), okrążenie rozpoczęte przed flagą można dokończyć, a przy równych czasach wyżej jest kierowca, który uzyskał czas wcześniej. Reguła 107% jest oznaczana w wynikach (start z końca stawki za zgodą sędziów). Po Q3 wyniki pojawiają się w oknie, a wyścig startuje w kolejności kwalifikacji. Uproszczenia: auta wyjeżdżają z pól startowych co 1,5 s, paliwo jest uzupełniane do 20 kg na linii mety zamiast przerw w boksie, przerwy między sesjami trwają 10 s.
- Tabela czasów pokazuje 10 najlepszych z 20 aut; śledzony kierowca lub gracz spoza pierwszej dziesiątki pojawia się pod kreską z rzeczywistą pozycją.
- Wyścig Grand Prix z procedurą startową, klasyfikacją, paliwem i uproszczonym postojem serwisowym. AI wybiera boczną linię wyprzedzania i omija wraki; lokalne żółte flagi ograniczają tempo i zabraniają wyprzedzania. Służby usuwają wrak 15 sekund czasu symulacji po wypadku lub zderzeniu (także w kwalifikacjach).
- Tory Grand Prix i owal, rysowanie własnej trasy oraz zapis i odczyt JSON. Automatyczne pobocza z trawy i żwiru, szersze po zewnętrznej stronie zakrętów, oraz bandy.
- Telemetria prędkości, przyspieszeń, paliwa, obciążeń osi, czasów, nawierzchni i przyczyny DNF.
- Rzadkie błędy hamowania lub skrętu AI w treningu i wyścigu; ochrona rekordowych sieci przed oceną takich okrążeń.
- Sterowanie gracza: WASD lub strzałki; P zgłasza postój.
- Profile obliczeniowe, pauza i przyspieszenie symulacji.
- „Czysta tablica” (panel sterowania): po potwierdzeniu wszyscy kierowcy zapominają wszystko, czego się nauczyli (sieci, linie przejazdu, tempo, rekordy, generacje), autozapis jest usuwany, a trwająca sesja przerwana. Tor i ustawienia zostają; stawka startuje jak po pierwszym uruchomieniu.
- Wyspy treningowe (suwak w ustawieniach): dodatkowe Web Workery trenują w tle własne stawki na tym samym torze, na wolnych rdzeniach (np. rdzenie wydajnościowe Apple M1). Co 30 s czasu symulacji kierowca przejmuje model z wyspy tylko przy szybszym czystym okrążeniu, tej samej presji i tych samych wejściach sieci; przerwane tym okrążenie nie ocenia modeli. Jedna wymiana podmienia najwyżej ćwierć stawki (największe zyski najpierw), żeby stawki nie zbiegały jednocześnie do tych samych modeli. Wyspy stoją przy pauzie, w kwalifikacjach i w wyścigu. GPU nie jest używane: sieci są zbyt małe (ok. 2% czasu kroku), by zyskać na przesyłaniu danych do karty.
- Ochrona przed przeuczeniem:
  - Trudne okrążenia (suwak, domyślnie 25%): część okrążeń treningowych jedzie się w losowych warunkach. Przyczepność wynosi od −8% do +3%, moc ±4%, a LIDAR widziany przez sieć ma szum i przesunięcie kalibracji. Planista o tym nie wie. Poprawki strażnika na tych okrążeniach uczą odporności. Takie okrążenia nie ustanawiają rekordów i nie oceniają modeli, więc szczęśliwe warunki nie wygrywają selekcji. W kwalifikacjach i wyścigu warunki są zawsze nominalne.
  - Wyjście ze stagnacji: po 8 czystych okrążeniach bez rekordu kierowca przez jedno okrążenie jedzie silniej zmutowaną kopią rekordowej sieci. Jeśli pobije rekord, kopia zostaje. Jeśli nie, wraca sprawdzona sieć, więc rekord nigdy się nie pogarsza. Kolejne nieudane próby zwiększają krok mutacji, najwyżej do 12%.

## Fizyka

Model uwzględnia masę paliwa, moc i trakcję napędu, docisk, wektor oporu powietrza oraz wspólne koło tarcia dla sił opon. Szerokość toru jest wyrażona w metrach. Telemetria pokazuje przyspieszenie wynikające ze zmiany prędkości.

### Pogoda

Pogodę wybiera się w panelu wyścigu jako prognozę (`src/physics/Weather.ts`): słonecznie (stabilnie, punkt odniesienia kalibracji: powietrze 25 °C, tor 38 °C, bez wiatru), upał, pochmurno, silny wiatr, przelotny deszcz, deszcz, burza i zmienna. Pogoda działa w treningu, kwalifikacjach i wyścigu i zmienia się w czasie symulacji: chmury dryfują, a gdy zgęstnieją, pada deszcz. Słońce nagrzewa tor (w upale do ok. 55 °C), deszcz go chłodzi i moczy, a po opadzie słońce i ciepły asfalt go suszą. Wiatr ma średnią siłę i kierunek, porywy oraz wolno skręcający kierunek. Każdy wyścig i kwalifikacje zaczynają od prognozy z nowym ziarnem.

- **Temperatura toru i powietrza** wchodzą do bilansu cieplnego opon: na gorącym torze opony wychodzą z okna pracy i szybciej się zużywają, na zimnym wolniej się rozgrzewają.
- **Woda** obniża przyczepność slicków (patrz niżej). AI zjeżdża po intery lub deszczówki, gdy zacznie padać, i wraca na slicki, gdy tor przeschnie.
- **Wiatr** zmienia prędkość względem powietrza: wiatr czołowy 8 m/s obniża prędkość maksymalną z ok. 310 do 290 km/h, w plecy podnosi ją do ok. 327 km/h. Wiatr boczny zabiera docisk (najbardziej przedniemu skrzydłu), pcha bolid w bok i skręca go, a porywy zmieniają te siły w czasie.

W treningu okrążenia porównuje się w obrębie jednej klasy warunków (sucho / wilgotno / mokro). Okrążenie, na którym warunki wyszły poza klasę sesji, liczy się do czasu, ale nie ocenia sieci. Pierwsze czyste okrążenie w nowych warunkach ustala nowy rekord odniesienia, a sprawdzony mózg zostaje. Wyspy treningowe mają własną pogodę z tej samej prognozy i wymieniają tylko modele z tych samych warunków. Sieć nie dostała nowych wejść, więc zapisane modele nadal się wczytują.

W 3D chmury przełączają niebo na pochmurne i przygaszają słońce, deszcz pada wokół kamery i jest znoszony przez wiatr, mokry asfalt ciemnieje i błyszczy, a bolidy ciągną za sobą pióropusz wody. Dym i spray znosi wiatr. Telemetria pokazuje pogodę, temperatury, wiatr ze strzałką kierunku i stan nawierzchni.

### Opony i nawierzchnia

W wyścigu i kwalifikacjach bolidy jeżdżą na pięciu mieszankach (`src/physics/Tyres.ts`): Soft (S, czerwona), Medium (M, żółta, punkt odniesienia kalibracji), Hard (H, biała), Intermediate (I, zielona) i Wet (W, niebieska). Mieszanka zmienia szczytową przyczepność (soft +3,5%, hard −3%, intery −12% i deszczówki −18% na suchym), okno temperatury pracy (95 / 100 / 108 / 80 / 70 °C) i tempo zużycia (×1,8 / ×1 / ×0,6 / ×2,6 / ×3,4). Wilgotność toru wynika z pogody. Woda obniża przyczepność slicków do ~45% na mokrym, chłodzi opony i zmniejsza zużycie. Intery są najszybsze na wilgotnym torze, deszczówki w ulewie. W treningu bolid dostaje opony właściwe dla warunków przy resecie i zjeżdża po nie, gdy warunki się zmienią.

AI startuje na mieszance zależnej od pola startowego (medium / soft / hard) albo na oponach dobranych do pogody. W boksie zmienia slicki (na hard, z hard na medium), a gdy nawierzchnia zmieni się w trakcie wyścigu (deszcz, przesychanie), zjeżdża po opony właściwe dla warunków. Gracz wybiera swoją mieszankę na start i na każdy pit stop. Mieszankę widać w tabeli wyników i telemetrii, a w 3D jako kolorowy pasek na boku opony.

To model hybrydowy do gry. Nie zawiera pełnej dynamiki yaw, kontaktów między bolidami ani fizycznego przejazdu aleją serwisową. Osiągi nie są kalibrowane względem konkretnego bolidu F1. Szczegóły, stałe i ograniczenia opisuje [PHYSICS.md](PHYSICS.md).

Po zmianie fizyki z 04.10.2026 dawne rekordy i modele AI wymagają ponownego treningu. Zmiana ERS na regulamin 2026 (13.10.2026) ponownie zmienia czasy okrążeń, więc dawne rekordy nie są porównywalne. Pliki modeli z 10 kierowcami nadal się wczytują: drugi kierowca zespołu dostaje lekko zmutowaną kopię sieci partnera. Droga hamowania i czasy okrążeń zmieniły się wraz z poprawą limitów tarcia i skali drogi.

## Uruchomienie

Wymagany Node.js 20.19+ albo 22.12+ (zgodnie z wymaganiami Vite) i npm.

```bash
npm ci
npm run dev
```

Vite wyświetli lokalny adres aplikacji, domyślnie `http://localhost:5173`.

```bash
npm test               # regresje fizyki, wyścigu, treningu, poboczy i pomyłek
npm run test:learning  # ochrona wiedzy AI i zmiany generacji
npm run test:qualifying # zasady Q1–Q3, siatka startowa
npm run test:islands   # wyspy treningowe: przenoszenie toru i reguły wymiany modeli
npm run test:robustness # trudne okrążenia, próby wyjścia ze stagnacji, limit migracji
node scripts/bench-laptime.mjs 1800 145,456,789 # pomiar postępu nauki (ok. 15 min)
npm run bench:step     # przepustowość fizyki: µs na krok i skrót stanu (do porównań po optymalizacjach)
npm run test:runoff    # pobocza, bandy, powrót na asfalt i pomyłki AI
npm run audit:physics  # wyniki prób numerycznych
npm run build          # TypeScript i produkcyjne dist/
npm run preview        # podgląd zbudowanej wersji
```

## Struktura

- `src/main.ts` — interfejs, obsługa wejścia i pętla renderowania.
- `src/workers/` — symulacja, protokół komunikacji i akumulator czasu.
- `src/physics/Car.ts` — dynamika, sterowanie AI, paliwo, obrys i pomiar okrążeń.
- `src/ai/` — sieci neuronowe i populacja kierowców.
- `src/track/`, `src/math/` — geometria, presety, spline i wektory.
- `src/rendering/Renderer.ts` — Canvas, tor, bolidy i telemetria.
- `scripts/audit-physics.mjs` — odtwarzalne próby i testy regresyjne.

## Dokumentacja

- [Aktualny model fizyki](PHYSICS.md).
- [Audyt fizyki przed naprawami](AUDIT_PHYSICS.md).
- [Historyczny audyt aplikacji](AUDIT.md).
- `opis.md` i `opis.txt` — archiwalne opisy wcześniejszej implementacji.

Projekt pierwotnie rozwijano przy użyciu Gemini Antigravity.

Widok toru: przyciski +/− lub kółko myszy zmieniają zoom (25–800%). Przeciągnięcie przesuwa widok i wyłącza śledzenie. „Cały tor” dopasowuje trasę do okna. Wybierz zawodnika w tabeli lub kliknij auto, następnie włącz „Śledź zawodnika”; kamera podąża za wybranym autem także po zmianie generacji. Bez wcześniejszego wyboru przycisk wybiera aktualnego lidera.

Wyjazd poza asfalt nie eliminuje bolidu: trawa zmniejsza przyczepność, a żwir dodatkowo wyhamowuje ruch. Lekki kontakt z bandą wygasza ruch w jej kierunku i zmniejsza prędkość wzdłuż bandy. Uderzenie z prędkością prostopadłą co najmniej 12 m/s powoduje DNF w wyścigu lub respawn w treningu. Samochód zatrzymany głęboko w żwirze może ugrzęznąć i zakończyć jazdę z powodu braku postępu.

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
