# Audyt fizyki symulatora — 2026-11-20

> **Stan po weryfikacji (20.11.2026).** Punkt 2 (przejście kinematyka → dynamika) potwierdzono pomiarem i naprawiono. Punkt 1 był trafny częściowo: planista znał już ślad aero i uszkodzenia, a najważniejszy pominięty czynnik to wiatr wzdłuż toru; planista zna go teraz razem z aquaplaningiem. Punkt 3 rozstrzyga konstrukcja kodu, a pilnuje go test własnościowy. Punkt 4 pozostaje ograniczeniem; dodano testy niezmienników opon, kalibracja czeka na dane. Szczegóły: `PLAN_DZIALAN_FIZYKA_2026-11-20.md`, `PHYSICS.md` („Poprawki z audytu fizyki z 20.11.2026”) i `raport/2026-11-20/POMIARY.md`.

## Zakres i metoda

Przegląd statyczny kodu fizyki i planowania jazdy. Sprawdzono przede wszystkim src/physics/Car.ts, src/physics/DrivePlanner.ts, src/physics/Tyres.ts, src/physics/Weather.ts oraz opisy i skrypty audytowe. Nie uruchamiano testów, benchmarków ani symulacji porównawczych. Wnioski o błędach implementacji wynikają z przepływu kodu; ocena realizmu wymaga kalibracji do telemetrii lub danych referencyjnych.

## Znaleziska

### 1. Planer hamowania i zakrętów nie odtwarza bieżącego modelu aerodynamiki — ważność: wysoka

W DrivePlanner.ts:84-93 oraz 257-266 estymacja siły docisku opiera się na stałym udziale PLAN_AERO_SHARE (90%) oraz współczynniku bazowym. Nie uwzględnia wprost wszystkich czynników używanych przez fizykę w Car.ts:1611-1633: otwarcia aktywnej aerodynamiki, pracy podłogi zależnej od prześwitu i stall, przesunięć balansu, bocznego wiatru oraz strat docisku z wake. Uwzględnia część strat uszkodzeń i wake, ale nie pełny stan auta. Analogiczna różnica występuje w estymacji siły potrzebnej do hamowania.

**Ryzyko:** ekspert może wyznaczać prędkość zakrętu lub punkt hamowania przy założeniach o docisku innych niż te, które obowiązują w następnym kroku fizyki. To może powodować systematyczne niedohamowanie albo nadmierną ostrożność zależnie od warunków.

**Proponowana poprawka:** wydzielić wspólną, bezstanową funkcję przewidywania docisku i limitów opon, z parametrami prędkości, prześwitu, wake, aktywnej aero i pogody. Planer powinien używać tej samej funkcji co krok fizyki, z konserwatywnym marginesem na przyszłą zmianę stanu.

### 2. Przejście między modelem kinematycznym a dynamicznym wymaga walidacji — ważność: średnia, hipoteza

W Car.ts:1797-1803 i 1808-1867 odpowiedź boczna jest mieszana zależnie od prędkości: od modelu kinematycznego do modelu jednośladowego. Oba modele mają różne założenia. W modelu dynamicznym występuje relaksacja kąta znoszenia, nasycenie sił osi i dynamika yaw; wartości końcowe są interpolowane z odpowiedzią kinematyczną.

**Ryzyko:** możliwa zmiana charakterystyki prowadzenia w okolicy zakresu przejściowego (od DYNAMIC_FROM do dwukrotności tej wartości). Sam kod nie dowodzi, że występuje skok ani artefakt.

**Proponowana poprawka:** wykonać deterministyczne testy ustalonego promienia i skoku skrętu dla prędkości w całym zakresie przejściowym, sprawdzając siłę boczną, yaw rate, poślizg i temperaturę opon. Jeśli pojawi się niefizyczny trend, interpolować wspólne wielkości modelu lub zastosować jeden model dynamiczny także przy małych prędkościach z bezpiecznym ograniczeniem.

### 3. Model sił osi i koła tarcia jest złożony; potrzebny test bilansu — ważność: średnia, do weryfikacji

Siły hamowania, napędu i boczne są obliczane w kilku etapach: limity hamulców i rekuperacji w Car.ts:1681-1767, a siły boczne oraz wykorzystanie osi w 1797-1867. Implementacja ma osobne ograniczenia dla osi, różny budżet hamowania i napędu oraz rozdział obciążenia na koła. Z samego przeglądu nie wynika jednoznacznie naruszenie limitu, ale rozłożenie rachunku utrudnia potwierdzenie, że końcowy wektor siły każdej osi zawsze mieści się w dozwolonym limicie.

**Proponowana poprawka:** dodać testy własnościowe dla każdej osi: przy dowolnym połączeniu skrętu, hamowania i napędu norma znormalizowanego wektora siły nie przekracza przyjętej elipsy przyczepności (z wyjątkiem jawnie modelowanego poślizgu/lock-up). W razie rozbieżności centralnie ograniczać wektor siły osi przed integracją.

### 4. Model opon i mieszanek jest kalibrowany parametrami, których realizmu nie da się potwierdzić samym kodem — ważność: średnia, ograniczenie modelu

Mieszanki i ich krzywe przyczepności są opisane parametrami w Tyres.ts:29-33; temperatura, zużycie i praca poślizgu aktualizowane są w Car.ts. Przegląd statyczny nie pozwala ocenić, czy tempo zużycia i zakres temperatur odpowiadają rzeczywistemu stintowi. Model opon agreguje istotne zjawiska do uproszczonych współczynników.

**Proponowana poprawka:** przygotować scenariusze kontrolowane (jazda prosto, stały promień, poślizg, różne mieszanki i mokro) i porównać temperatury, degradację oraz przyczepność z danymi referencyjnymi. Dopiero po tej kalibracji zmieniać współczynniki.

## Zalecana kolejność

1. Ujednolicić estymację docisku i limitów opon używaną przez planer i fizykę.
2. Dodać test bilansu sił osi przy hamowaniu/napędzie w zakręcie.
3. Zmierzyć płynność przejścia modelu bocznego w zakresie prędkości przejściowych.
4. Kalibrować mieszanki i zużycie opon na podstawie kontrolowanych przejazdów.

## Ograniczenia

To audyt statyczny, nie walidacja wyników okrążeń. Nie stwierdzono tu potwierdzonego błędu numerycznego ani niezgodności z danymi rzeczywistego bolidu. Pozycje 2–4 są ryzykami lub obszarami do weryfikacji, a punkt 1 wskazuje konkretną rozbieżność między uproszczonym predyktorem planera a pełnym modelem sił.
 
