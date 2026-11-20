# Pomiary do audytu fizyki z 20.11.2026

Audyt: `AUDYT_FIZYKI_2026-11-20.md`. Weryfikacja i plan: `PLAN_DZIALAN_FIZYKA_2026-11-20.md`. Opis zmian: `PHYSICS.md`, sekcja „Poprawki z audytu fizyki z 20.11.2026”. Surowe wyniki są w `dane/`.

Stan wyjściowy: commit `55b341e`. Każdy etap mierzono na osobnej kopii drzewa źródeł, więc liczby „przed” i „po” różnią się tylko tym jednym etapem.

## Etap 1: przejście kinematyka → dynamika

Test `npm run test:blend` przed poprawką oblewał 94 sprawdzenia (ten sam skok przy 8,05 m/s przy 30, 60 i 120 Hz), po poprawce przechodzi.

`npm run diag:lowspeed -- 900` (ekspert solo, 900 s, udział kroków w paśmie prędkości):

| Tor | Pasmo | `isSliding` | `isSkidding` | gaz | przyspieszenie boczne |
| --- | --- | --- | --- | --- | --- |
| GP | 8–12 m/s | 51,4% → 0% | 74,3% → 0% | 0,28 → 0,55 | 0,44 → 0,48 g |
| Monako | 8–12 m/s | 93,2% → 0% | 97,3% → 64% | 0,12 → 0,07 | 1,04 → 1,45 g |
| Monako | 12–16 m/s | 10,5% → 2,5% | 33,9% → 23,8% | 0,17 → 0,13 | 0,75 → 0,84 g |
| Hungaroring | 12–16 m/s | 32,4% → 38,3% | 38,0% → 50,2% | 0,53 → 0,34 | 0,56 → 0,58 g |
| Hungaroring | 16–25 m/s | 50,8% → 52,5% | 81,8% → 81,9% | 0,22 → 0,22 | 1,32 → 1,31 g |

Na Hungaroringu pasmo 12–16 m/s to 0,1–0,5% kroków (kilkadziesiąt do kilkuset), a udział poślizgu jest tam niższy niż w paśmie 16–25 m/s, w pełni dynamicznym, więc kryterium z planu jest spełnione.

Najlepsze okrążenie eksperta (bez pierwszego): GP 50,847 → 50,838 s, Monako 83,173 → 82,765 s, Monza 90,124 → 90,154 s, Hungaroring 95,157 → 95,125 s.

`node scripts/bench-laptime.mjs 1800 145,456,789` (GP, 20 aut, średnie z 3 ziaren): najlepsze 51,11 → 49,66 s, mediana rekordów 53,06 → 53,19 s, `lateMedian` 55,78 → 55,72 s, okrążenia 630,7 → 632,3, poza asfaltem 0,15% → 0,12%.

`node scripts/test-tracks.mjs 4 1 <tor>` (stawka, ok. 82 min symulacji, budżet czasu rzeczywistego):

| Tor | okrążenia | najlepsze | poza asfaltem |
| --- | --- | --- | --- |
| Monako | 1043 → 1046 | 1:23,116 → 1:23,222 | 0,8% → 0,6% |
| Hungaroring | 858 → 879 | 1:37,809 → 1:36,816 | 1,2% → 0,9% |
| Singapur | 803 → 760 | 1:49,693 → 1:50,656 | 0,5% → 0,3% |

Skróty `bench:step -- 60`: przed `4d5b1d7422f1cc5a`, `3012e44e28464093`, `f4684d5fe70b9c5c`; po `67cd15e0287f8a83`, `a744b244bccee1eb`, `5205d38566cce9ed`.

## Etapy 3 i 4.1: testy bez zmiany fizyki

`npm run test:units`: koło tarcia osi na 2000 losowych stanach (1733 dynamicznych, 267 kinematycznych, 173 z blokadą; ziarno stałe), największe wykorzystanie 1,000 na obu osiach; niezmienniki mieszanek; punkty zmiany opon przy wilgotności 0,251 (slick → intery) i 0,719 (intery → deszczówki).

## Etap 2: planista, wiatr i aquaplaning

W bezwietrznej pogodzie skróty `bench:step` są takie same jak po etapie 1, więc pomiary `bench-laptime` i `test-tracks` (pogoda odniesienia) się nie zmieniają.

`node scripts/diag-weather.mjs 600 sunny,windy,storm,shower 1,2,3` (stawka 20 aut, GP, średnie z 3 ziaren):

| Scenariusz | wypadki/min | poza asfaltem | czyste okrążenia | mediana | przejęcia strażnika | hamowania awaryjne |
| --- | --- | --- | --- | --- | --- | --- |
| Słonecznie | 0,07 → 0,07 | 0,14% → 0,14% | 146,7 → 146,7 | 54,43 → 54,43 s | 1,58% → 1,58% | 1,23% → 1,23% |
| Silny wiatr | 3,43 → 0,27 | 4,28% → 0,66% | 55,7 → 120,7 | 55,94 → 55,23 s | 18,18% → 2,33% | 1,07% → 1,71% |
| Burza | 3,87 → 1,40 | 4,72% → 1,69% | 49,3 → 94,0 | 63,45 → 62,26 s | 3,23% → 2,66% | 3,77% → 0,64% |
| Przelotny deszcz | 0,43 → 0,20 | 0,77% → 0,29% | 74,3 → 76,7 | 56,69 → 55,68 s | 16,26% → 12,36% | 0,68% → 0,85% |

Przejęcia i hamowania awaryjne to udział kroków jazdy siecią. W wietrze udział hamowań awaryjnych wzrósł, ale podzielony przez liczbę czystych okrążeń spadł z 0,019 do 0,014 (przy zbliżonej liczbie kroków jazdy), więc na okrążenie jest ich mniej. Strażnik częściej hamuje przed zakrętem z wiatrem w plecy, a rzadziej przejmuje auto po utracie kontroli.

`node scripts/diag-weather.mjs 900 sunny,windy,storm,shower 1,2,3 --expert` (ekspert solo):

| Scenariusz | czyste okrążenia | najlepsze | mediana | poza asfaltem | wypadki/min |
| --- | --- | --- | --- | --- | --- |
| Słonecznie | 13 → 13 | 49,79 → 49,79 s | 51,09 → 51,09 s | 0,13% → 0,13% | 0 → 0 |
| Silny wiatr | 2,7 → 12,3 | 48,41 → 50,57 s | 49,73 → 51,04 s | 7,20% → 0% | 0,62 → 0 |
| Burza | 6,3 → 10,3 | 56,43 → 56,84 s | 57,56 → 58,30 s | 3,55% → 0,04% | 0,20 → 0 |
| Przelotny deszcz | 7,7 → 9,3 | 49,55 → 50,38 s | 52,65 → 55,18 s | 0,59% → 0,10% | 0,05 → 0 |

Dawne najlepsze okrążenia eksperta w wietrze to pojedyncze okrążenia, które przetrwały z planem za szybkim na zakręty z wiatrem w plecy. W deszczu ekspert hamuje na slickach z zapasem (aquaplaning liczony przy prędkości początkowej hamowania), więc jest wolniejszy, ale nie wypada.

Koszt kroku (`bench:step -- 60`, wolny procesor): 771 µs przed etapami, 763 µs po etapie 1, 779 µs po etapie 2.

## Runda 2: aquaplaning w strefie, hamowanie po krzywej planu, opony

### Aquaplaning dzielony na progu 200 km/h

Strefa hamowania jest dzielona na progu aquaplaningu: powyżej tracona jest przyczepność przy średniej prędkości tego odcinka, poniżej obowiązuje pełna. Wcześniej utrata przy prędkości początkowej obowiązywała w całej strefie. „Przelotny deszcz”, stawka, 3 ziarna: wypadki 0,20 → 0,13 na minutę, hamowania awaryjne 0,85% → 0,57% kroków. W „Zmiennej” pogodzie nic się nie zmieniło, bo aquaplaningu tam nie ma. Test: `test-weather` (droga i prędkość wejścia odwracają się wzajemnie, ciągłość na progu, wynik między pełną a utraconą przyczepnością).

### Pełne `test:tracks` (stan wyjściowy kontra etapy 1–2)

38 torów, 20 min przy 8 wątkach na drzewo, oba przebiegi bez problemów. Średni czas poza asfaltem 0,86% → 0,86%, mediana zmiany najlepszego okrążenia −0,27 s (24 tory szybsze, 14 wolniejszych). Pojedyncze tory odchylają się w obie strony (Johannesburg 4,9% → 2,5%, Miami 2,1% → 3,1%), w granicach rozrzutu testu z budżetem czasu rzeczywistego. Dane: `dane/` i `PHYSICS.md`.

### Hamowanie eksperta po krzywej planu

Przyczyna: Albert Park, zakręt 3, deszczówki przy wilgotności 0,7, wyjazd na żwir w 6 z 6 ziaren. Wyniki siatki budżetów, testu nauczyciela (48 przejazdów) i pomiarów stawki są w `PHYSICS.md` („Hamowanie eksperta po krzywej planu”). Surowe wyniki: `dane/3-*`.

| Pomiar | Przed (etapy 1–2) | Po |
| --- | --- | --- |
| Ekspert, 6 torów, sucho, tryb wyścigu | 497,6 s, 0,68% poza asfaltem | 501,9 s, 0% |
| Ekspert, woda 0,7, deszczówki | 553,8 s, 0,12% | 559,3 s, 0% |
| Ekspert, woda 0,3, intery | 530,3 s, 0,66% | 535,1 s, 0% |
| Test nauczyciela (GP, 48 przejazdów) | 0 wypadków | 0 wypadków |
| `bench-laptime 1800`: mediana rekordów / `lateMedian` | 53,19 / 55,72 s | 52,75 / 55,87 s |
| `diag-weather`, stawka, 4 scenariusze × 3 ziarna | 58 wypadków, 1314 okrążeń | 60 wypadków, 1327 okrążeń |

Odrzucone warianty: czysta krzywa planu (1–2 wypadki na 48), budżet 0,55 (3 na 48), dodatkowy budżet na prostej (1–2 na 48).

### Opony

`node scripts/diag-tyres.mjs`: stinty, skidpad i czas okrążenia według wilgotności. Dane referencyjne ze źródłami są w `PHYSICS.md` („Opony: pomiar i dane referencyjne”).

- **Sucho:** kolejność mieszanek zależy od toru. Na GP najszybszy jest hard (49,64 s wobec 50,71 s na soft), bo wszystkie mieszanki są tam przegrzane, a hard ma najwyższe optimum. Na Monzy hard jest o 5% za wolny, bo jest zimny. Nie zmieniono, bo wymaga to zmiany modelu ciepła i okien.
- **Mokro:** punkty zmiany opon wypadają przy 103–106% i 108–111% suchego czasu okrążenia, a według Pirelli przy ok. 112% i 116–118%. Wariant K trafiał średnio w 110,1% i 114,9%, ale w deszczu stawka rozbijała się nawet 20 razy częściej (0,07 → 1,40 na minutę). Nie wprowadzono go. Najpierw AI musi poradzić sobie z małą przyczepnością.

Skróty `bench:step -- 60` po rundzie 2: `851b267dad2d3bec`, `0a297de3174bbee5`, `2a49fb4c22d6689e`, koszt kroku 764 µs.

## Runda 3: opony na mokrym, pogoda w trakcie sesji, okna na suchym

- **Opony nowych aut.** Konstruktor `Car` zostawiał domyślne medium. Stawka utworzona na mokrym torze startowała więc na slickach; to dawało 40 z 42 wypadków w pierwszej próbie kalibracji na mokrym. Teraz nowe auto dostaje opony dobrane do pogody, a na suchym nic się nie zmienia (te same skróty `bench:step`).
- **Zmiana prognozy w trakcie sesji** (wybór w panelu i wyspy) działa stopniowo: `Weather.changeForecast` zostawia stan toru i powietrza. Decyzja użytkownika: „Stopniowo”.
- **Kalibracja opon na mokrym** jest wprowadzona (`Tyres.ts`). Średnio 110,1% / 115,0% / 120,0% suchego czasu okrążenia, wobec Pirelli ok. 112% i 116–118%. Pomiar stawki i eksperta jest w `PHYSICS.md` („Opony: pomiar i dane referencyjne”), surowe wyniki w `dane/5-*`. Wypadków przybyło tylko przy burzy wybranej w trakcie sesji, gdy auta są na slickach (0,57 → 1,60 na minutę).
- **Okna temperatur na suchym** nie zostały zmienione. Przód pracuje średnio o 26 °C cieplej od tyłu (mediany 117 i 92 °C na 39 torach). Mniejsze grzanie przodu poprawia temperatury, ale destabilizuje auto (soft rozbija się na GP), więc potrzebne jest przestrojenie równowagi.

## Czego nie zmierzono

- `npm run diag:nn` z planu (etap 0, punkt 3) zastąpiły `diag-weather` (stawka z interwencjami strażnika według przyczyny) i `diag-lowspeed`.
- Pełne `npm run test:tracks` uruchomiono po etapach 1–2 (runda 2), nie po zmianie hamowania.
- Kalibracja opon na suchym (okna temperatur) nie została wprowadzona; na mokrym wprowadzona w rundzie 3.
