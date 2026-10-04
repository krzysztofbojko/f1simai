# Audyt F1 AI Simulator — 20.09.2026

Badana rewizja: `a3d266631f1641446b63826065ab3686eae75f98`.

Audyt obejmował fizykę, AI, geometrię toru, wyścig, UI, worker, import/eksport oraz konfigurację. Poniższe problemy zweryfikowano w kodzie i ukierunkowanych reprodukcjach. Nie wprowadzano napraw kodu aplikacji.

P1 oznacza wysoki priorytet: utratę wiedzy AI lub blokadę podstawowego procesu. P2 oznacza błąd funkcjonalny wymagający naprawy w następnej kolejności.

## Potwierdzone problemy

### 1. P1 — Import modeli AI usuwa właśnie wczytane wagi

Lokalizacje: `src/workers/sim.worker.ts:723`, `src/workers/sim.worker.ts:809`, `src/ai/Population.ts:407`, `src/main.ts:941`.

Obie komendy importu wywołują `population.resetAll(track)` po odczycie wag. Ta metoda tworzy nowe sieci, nadpisuje `car.brain` i `record.bestBrain` oraz zeruje rekordy. Worker mimo to odpowiada komunikatem sukcesu. W lokalnej ścieżce pojedynczego importu `resetCarPositions()` również przywraca poprzedni `bestBrain`.

Reprodukcja: ustawiono rozpoznawalną wagę `12345` w poprawnym modelu, wysłano `LOAD_BRAIN` oraz osobno `LOAD_ALL_MODELS`. Oba handlery zgłosiły sukces, ale waga została zastąpiona. Zaimportowany `globalBestLap=60` po drugim handlerze wynosił `null`.

Zalecenie: rozdzielić reset pozycji i stanu jazdy od resetu sieci; po walidacji importować atomowo aktywne i najlepsze modele, a następnie resetować wyłącznie jazdę. Dodać test eksport–import–eksport.

### 2. P1 — Pauza nadal trenuje sieci neuronowe

Lokalizacje: `src/workers/sim.worker.ts:188`, `src/workers/sim.worker.ts:380`, `src/physics/Car.ts:406`, `src/main.ts:1683`.

Pauza zatrzymuje kroki fizyki, ale `simLoop()` nadal wywołuje `createSnapshot()`. Serializacja wywołuje `getAIControl()`, które dodaje próbki do replay buffer i okresowo trenuje sieć. HUD także używa tej metody. W trakcie jazdy dochodzi ponadto do dodatkowego uczenia poza właściwymi krokami symulacji.

Reprodukcja: dla zatrzymanego workera i bolidu z ustawioną prędkością wykonano 90 samych snapshotów. Licznik replay wzrósł z 0 do 90, bufor do 40, a wagi się zmieniły, mimo braku kroku fizyki.

Zalecenie: snapshot i HUD powinny czytać zapisane sterowanie z ostatniego kroku. Próbkowanie doświadczeń i trening wykonywać wyłącznie w kontrolowanej pętli symulacji.

### 3. P1 — Czysta instalacja zależności kończy się błędem

Lokalizacje: `package.json:11`, `package-lock.json:7`.

Manifest wymaga TypeScript `^5.0.0` i Vite `^5.0.0`, a lockfile zapisuje TypeScript `7.0.2` i Vite `8.3.0`, również w deklaracjach pakietu głównego. Zainstalowane `node_modules` odpowiada lockfile, a nie manifestowi.

Reprodukcja: `npm ls --depth=0` zwraca `ELSPROBLEMS`. `npm ci --ignore-scripts` uruchomione na kopii obu plików w `/tmp` zwraca `EUSAGE` z informacją o niespójnym lockfile. Istniejący lokalny build przechodzi, ale nie dowodzi odtwarzalności instalacji.

Zalecenie: wybrać wspierane wersje, uzgodnić manifest i lockfile oraz sprawdzić czystą instalację i build. Uzgodnić z nimi wymagania Node.js w README.

### 4. P2 — Klasyfikacja i straty ignorują postęp w obrębie okrążenia

Lokalizacje: `src/workers/sim.worker.ts:209`, `src/workers/sim.worker.ts:232`, `src/physics/Car.ts:464`.

Po liczbie okrążeń sortowanie porównuje `totalRaceTime`, który rośnie o ten sam krok czasu dla wszystkich jadących bolidów. Nie uwzględnia checkpointu ani odległości wzdłuż toru. Różnica tych zegarów nie stanowi straty czasowej na wspólnym punkcie pomiarowym.

Reprodukcja: dwa żywe bolidy na tym samym okrążeniu i z czasem 5 s ustawiono przy checkpointach 1 i 19. Bolid z tyłu pozostał liderem zgodnie z kolejnością tablicy, a drugi otrzymał stratę `+0.00s`.

Zalecenie: sortować po całkowitym dystansie wyścigu, a straty wyznaczać z czasów przejazdu tych samych punktów pomiarowych.

### 5. P2 — Okrążenie zaliczane przed linią mety

Lokalizacje: `src/physics/Car.ts:723`, `src/physics/Car.ts:753`.

Kod najpierw zwiększa indeks następnego checkpointu, a później uznaje wartość 0 za przejechanie mety. Warunek jest spełniony przy zaliczeniu checkpointu `n-1`, a nie przy przecięciu bramki start/meta. To samo zdarzenie uruchamia pit-stop.

Reprodukcja: na torze GP z 159 checkpointami ustawiono bolid dokładnie na checkpoincie 158, z prawidłowym postępem okrążenia. Metoda zwróciła ukończone okrążenie, choć odległość od checkpointu 0 wynosiła około 17,98 jednostki toru.

Zalecenie: wykrywać kierunkowe przecięcie linii mety z kontrolą kolejności checkpointów; oddzielić okrążenie wyjazdowe od mierzonego. Przetestować start z każdego pola.

### 6. P2 — Stan FINISHED nie zamraża wyniku wyścigu

Lokalizacje: `src/workers/sim.worker.ts:279`, `src/workers/sim.worker.ts:330`, `src/workers/sim.worker.ts:369`.

Po ustaleniu zwycięzcy zmienia się jedynie `raceState`. Kolejne kroki nadal aktualizują fizykę, czasy i stan bolidów, a klasyfikacja jest przeliczana z żywego stanu. Brakuje utrwalonego wyniku końcowego; bolidy mogą dalej pokonywać okrążenia lub rozbijać się po zakończeniu.

Reprodukcja: po wymuszeniu osiągnięcia dystansu wyścigu stan zmienił się na `FINISHED`. Następne wywołanie kroku zwiększyło `totalRaceTime` z 5,0167 do 5,0333 s.

Zalecenie: utrwalić moment ukończenia i klasyfikację. Jeżeli reszta stawki ma dojechać do mety, obsłużyć indywidualny stan ukończenia i nie aktualizować wyników już sklasyfikowanych bolidów.

### 7. P2 — Równoległe żądania do workera pozostawiają nierozwiązane Promise

Lokalizacje: `src/workers/SimBridge.ts:7`, `src/workers/SimBridge.ts:174`, `src/workers/SimBridge.ts:84`.

Każdy typ operacji ma tylko pojedynczy resolver. Drugie żądanie tego samego typu nadpisuje pierwszy. Nie ma identyfikatorów żądań, timeoutów ani odrzucania oczekujących operacji przy błędzie workera. Błąd workera jest tylko logowany.

Reprodukcja: dwa wywołania `getAllModels()` i dwie odpowiedzi `ALL_MODELS_RESULT` w teście z atrapą workera rozwiązały tylko drugą obietnicę. Pierwsza pozostała oczekująca. Zwykłym wyzwalaczem jest szybkie ponowienie eksportu przy zajętym workerze.

Zalecenie: identyfikatory żądań i mapa oczekujących operacji, timeout oraz obsługa błędów. Alternatywnie serializować operacje i blokować ponowne wywołanie w UI do zakończenia.

### 8. P2 — Hamulec nadaje prędkość stojącemu bolidowi

Lokalizacje: `src/physics/Car.ts:534`, `src/physics/Car.ts:548`.

Przy zerowej prędkości siła hamowania jest odejmowana od siły napędowej i nadaje pojazdowi prędkość wsteczną. Ograniczenie przejścia przez zero działa tylko, gdy poprzednia prędkość była dodatnia. W kolejnych krokach znak siły odwraca się i powstają oscylacje.

Reprodukcja: bolid na polu startowym, zerowa prędkość, zerowy gaz i pełny hamulec; osiem kroków `updatePhysics()` po 1/60 s. Prędkość wzdłużna wynosiła kolejno około `-0,486`, `0,000023`, `0`, `+0,486`, `0`, `+0,486` m/s. Hamulec porusza pojazd zamiast utrzymywać go w miejscu.

Zalecenie: ograniczać impuls hamowania do wartości potrzebnej do zatrzymania w danym kroku, w obu kierunkach. Osobno obsłużyć spoczynek i opory toczenia. Dodać regresję hamowania od zera i przez zero.

## Dodatkowe zgłoszenia wymagające dalszej weryfikacji

Agenci wskazali brak walidacji wymiarów sieci i granic danych toru oraz intensywne odtwarzanie DOM i alokacje obiektów. Są to zasadne obszary dalszych prac, lecz zgłoszonych skutków wydajnościowych nie potwierdzono pomiarem. Scenariusz importu niezgodnej sieci jest obecnie przesłonięty błędem resetu opisanym w punkcie 1. Nie uznano za poprawną reprodukcję pliku JSON z literalnym `NaN` lub `Infinity`, ponieważ taki tekst nie przechodzi `JSON.parse`; walidacja powinna jednak odrzucać także liczby przepełniające zakres i nadmierne rozmiary toru.

## Walidacja i ograniczenia

- `npm run build`: sukces na istniejących zależnościach; TypeScript i bundlowanie Vite przeszły.
- `npm ls --depth=0`: błąd niezgodnych wersji.
- Czyste `npm ci --ignore-scripts` w `/tmp`: błąd niespójności manifestu i lockfile.
- Ukierunkowane reprodukcje na skompilowanych modułach projektu: import pojedynczy i zbiorczy, uczenie podczas pauzy, miejsce zaliczania mety, klasyfikacja, dalsza symulacja po FINISHED.
- Osobna reprodukcja współbieżnych żądań `SimBridge` z atrapą Worker.
- Osobna reprodukcja hamowania stojącego bolidu przez osiem kroków fizyki.
- `git diff --check` przed utworzeniem raportu: sukces. Istniejący nieśledzony `aaa.txt` pozostawiono bez zmian.

Testy workera wykonano w izolowanym kontekście Node z atrapą `self` i zegara, z dostępem do stanu potrzebnym do odtworzenia przypadków brzegowych. Nie wykonano pełnego testu E2E w przeglądarce ani benchmarku FPS; nie potwierdzano deklaracji realizmu fizycznego względem danych rzeczywistych F1. Projekt nie definiuje skryptu `test` ani automatycznego zestawu regresyjnego w `package.json`.

Kolejność napraw: import i pauza → spójność instalacji → pomiar mety i klasyfikacja → zakończenie wyścigu → protokół żądań. Pierwsze testy regresyjne powinny chronić zachowanie wag, niezmienność pauzy i poprawne przejścia stanów wyścigu.
