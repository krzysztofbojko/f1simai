# Tory Formuły 1

Pliki `F1_AI_TRACK` do wczytania w symulatorze: przycisk **Wczytaj tor** albo przeciągnięcie pliku na widok toru.
Współrzędne są w metrach, pierwszy punkt leży na linii start/meta, a kolejność punktów to kierunek jazdy
(pole `direction`; symulator jej nie odwraca). Pliki generuje `npm run build:tracks` (`scripts/build-tracks.mjs`),
który sprawdza każdy tor tą samą walidacją co symulator; `trackWidth` to najszersza szerokość z 14/12/10/8 m, jaką tor przechodzi.

| Plik | Tor | Kraj | Długość (plik / lista) | Kierunek | Szerokość |
|---|---|---|---|---|---|
| `au-1953-melbourne.json` | Albert Park Circuit | Australia | 5278 m / 5278 m | zgodnie z ruchem wskazówek | 14 m |
| `it-1953-imola.json` | Autodromo Enzo e Dino Ferrari | Włochy | 4909 m / 4909 m | przeciwnie do ruchu wskazówek | 14 m |
| `it-1922-monza.json` | Autodromo Nazionale di Monza | Włochy | 5793 m / 5793 m | zgodnie z ruchem wskazówek | 14 m |
| `pt-1972-estoril.json` | Autódromo do Estoril | Portugalia | 4361 m / 4360 m | zgodnie z ruchem wskazówek | 14 m |
| `mx-1962-mexico-city.json` | Autódromo Hermanos Rodríguez | Meksyk | 4304 m / 4304 m | zgodnie z ruchem wskazówek | 14 m |
| `pt-2008-portimao.json` | Autódromo Internacional do Algarve | Portugalia | 4653 m / 4653 m | zgodnie z ruchem wskazówek | 14 m |
| `br-1977-jacarepagua.json` | Autódromo Internacional Nelson Piquet | Brazylia | 5031 m / 5031 m | przeciwnie do ruchu wskazówek | 14 m |
| `br-1940-sao-paulo.json` | Autódromo José Carlos Pace | Brazylia | 4309 m / 4309 m | przeciwnie do ruchu wskazówek | 14 m |
| `ar-1952-buenos-aires.json` | Autódromo Oscar Alfredo Gálvez | Argentyna | 4259 m / 4259 m | zgodnie z ruchem wskazówek | 14 m |
| `bh-2002-sakhir.json` | Bahrain International Circuit | Bahrajn | 5413 m / 5412 m | zgodnie z ruchem wskazówek | 14 m |
| `az-2016-baku.json` | Baku City Circuit | Azerbejdżan | 6003 m / 6003 m | przeciwnie do ruchu wskazówek | 10 m |
| `es-1991-barcelona.json` | Circuit de Barcelona-Catalunya | Hiszpania | 4652 m / 4657 m | zgodnie z ruchem wskazówek | 14 m |
| `mc-1929-monaco.json` | Circuit de Monaco | Monako | 3336 m / 3337 m | zgodnie z ruchem wskazówek | 12 m |
| `fr-1960-magny-cours.json` | Circuit de Nevers Magny-Cours | Francja | 4410 m / 4411 m | zgodnie z ruchem wskazówek | 14 m |
| `be-1925-spa-francorchamps.json` | Circuit de Spa-Francorchamps | Belgia | 7004 m / 7004 m | zgodnie z ruchem wskazówek | 14 m |
| `ca-1978-montreal.json` | Circuit Gilles Villeneuve | Kanada | 4362 m / 4361 m | zgodnie z ruchem wskazówek | 14 m |
| `us-2012-austin.json` | Circuit of the Americas | Stany Zjednoczone | 5514 m / 5513 m | przeciwnie do ruchu wskazówek | 14 m |
| `nl-1948-zandvoort.json` | Circuit Park Zandvoort | Holandia | 4259 m / 4259 m | zgodnie z ruchem wskazówek | 14 m |
| `fr-1969-le-castellet.json` | Circuit Paul Ricard | Francja | 5841 m / 5842 m | zgodnie z ruchem wskazówek | 14 m |
| `de-1932-hockenheim.json` | Hockenheimring | Niemcy | 4574 m / 4574 m | zgodnie z ruchem wskazówek | 14 m |
| `hu-1986-budapest.json` | Hungaroring | Węgry | 4381 m / 4381 m | zgodnie z ruchem wskazówek | 14 m |
| `us-1909-indianapolis.json` | Indianapolis Motor Speedway | Stany Zjednoczone | 4192 m / 4192 m | zgodnie z ruchem wskazówek | 14 m |
| `tr-2005-istanbul.json` | Istanbul Park | Turcja | 5338 m / 5338 m | przeciwnie do ruchu wskazówek | 14 m |
| `sa-2021-jeddah.json` | Jeddah Corniche Circuit | Arabia Saudyjska | 6178 m / 6174 m | przeciwnie do ruchu wskazówek | 14 m |
| `za-1961-johannesburg.json` | Kyalami Circuit | Południowa Afryka | 4521 m / 4261 m | przeciwnie do ruchu wskazówek | 14 m |
| `us-2023-las-vegas.json` | Las Vegas Street Circuit | Stany Zjednoczone | 6202 m / 6201 m | przeciwnie do ruchu wskazówek | 14 m |
| `qa-2004-lusail.json` | Losail International Circuit | Katar | 5419 m / 5419 m | zgodnie z ruchem wskazówek | 14 m |
| `sg-2008-singapore.json` | Marina Bay Street Circuit | Singapur | 4940 m / 5063 m | przeciwnie do ruchu wskazówek | 14 m |
| `us-2022-miami.json` | Miami International Autodrome | Stany Zjednoczone | 5410 m / 5410 m | przeciwnie do ruchu wskazówek | 14 m |
| `it-1914-scarperia-e-san-piero.json` | Mugello Circuit | Włochy | 5245 m / 5245 m | zgodnie z ruchem wskazówek | 14 m |
| `de-1927-nurburg.json` | Nürburgring | Niemcy | 5149 m / 5148 m | zgodnie z ruchem wskazówek | 14 m |
| `at-1969-spielberg.json` | Red Bull Ring | Austria | 4318 m / 4318 m | zgodnie z ruchem wskazówek | 14 m |
| `my-1999-sepang.json` | Sepang International Circuit | Malezja | 5543 m / 5543 m | zgodnie z ruchem wskazówek | 14 m |
| `cn-2004-shanghai.json` | Shanghai International Circuit | Chiny | 5451 m / 5451 m | zgodnie z ruchem wskazówek | 14 m |
| `gb-1948-silverstone.json` | Silverstone Circuit | Wielka Brytania | 5891 m / 5891 m | zgodnie z ruchem wskazówek | 14 m |
| `ru-2014-sochi.json` | Sochi Autodrom | Rosja | 5848 m / 5848 m | zgodnie z ruchem wskazówek | 14 m |
| `us-1956-dix.json` | Watkins Glen | Stany Zjednoczone | 5437 m / 5435 m | zgodnie z ruchem wskazówek | 14 m |
| `ae-2009-yas-marina.json` | Yas Marina Circuit | Zjednoczone Emiraty Arabskie | 5273 m / 5281 m | przeciwnie do ruchu wskazówek | 14 m |

Geometria jest przeskalowana (pole `scale`, zwykle 1,00–1,02), tak by linia środkowa po wygładzeniu splajnem symulatora
miała oficjalną długość toru (`generatedLengthMeters` ≈ `lengthMeters`, tolerancja 0,2 %). Wyjątki: Kyalami zachowuje skalę źródła
(dzisiejsza konfiguracja, inna niż w F1), Marina Bay ma długość konfiguracji od 2023 r. (4940 m).

## Pominięte

- Suzuka International Racing Course (`jp-1962`): symulator odrzuca geometrię: Asfalt toru przecina się. Narysuj trasę bez przecinających się odcinków.
- Circuito de Madring (`es-2026`): brak na liście torów F1 z Wikipedii

Bez geometrii w źródle (38 torów z listy): Adelaide Street Circuit, Ain-Diab Circuit, Aintree Motor Racing Circuit, AVUS, Circuito da Boavista, Brands Hatch, Circuit Bremgarten, Buddh International Circuit, Bugatti Circuit, Caesars Palace, Charade Circuit, Detroit Street Circuit, Dijon-Prenois, Donington Park, Fair Park, Fuji International Speedway, Circuito del Jarama, Circuito Permanente de Jerez, Korea International Circuit, Long Beach Street Circuit, Monsanto Park, Circuit Mont-Tremblant, Mosport International Raceway, Montjuïc Circuit, Nivelles-Baulers, Pedralbes Circuit, Pescara Circuit, Phoenix Circuit, Prince George Circuit, Reims-Gueux, Riverside International Raceway, Rouen-Les-Essarts, Scandinavian Raceway, Sebring International Raceway, Okayama International Circuit, Valencia Street Circuit, Zeltweg Airfield, Circuit Zolder.

## Źródła i licencje

- Geometria: [bacinger/f1-circuits](https://github.com/bacinger/f1-circuits), licencja MIT, © 2019-2025 Tomislav Bacinger (`scripts/data/f1-circuits.LICENSE`).
- Dane torów (typ, kierunek, lokalizacja, długość, sezony, liczba Grand Prix): [Lista torów Formuły 1](https://pl.wikipedia.org/wiki/Lista_tor%C3%B3w_Formu%C5%82y_1), Wikipedia, licencja CC BY-SA 4.0.
- Wyjątki: Las Vegas ma kierunek przeciwny do podanego na liście (tor jeździ się przeciwnie do ruchu wskazówek zegara). W Monaco źródło zaczyna się w zakręcie Sainte Dévote, więc linia startu jest przesunięta o 200 m wstecz, na Boulevard Albert 1er.

Test wytrzymałościowy: `npm run test:tracks [minuty=20] [wątki=12] [filtr]` trenuje pełną stawkę na każdym torze bez przeglądarki i sprawdza kierunek, długość, ukończone okrążenia, przejechaną część toru i średnią prędkość.
