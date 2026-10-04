# Aktualny model fizyki

Stan po poprawkach z 04.10.2026. Ten dokument zastępuje historyczny opis fizyki w `opis.md` i `opis.txt`.

## Jednostki i geometria

Świat używa metrów, sekund, kilogramów i radianów. Jedna jednostka współrzędnych odpowiada jednemu metrowi. Szerokość toru 14 m oznacza rzeczywistą szerokość geometrii 14 jednostek. Kamera odpowiada za skalowanie obrazu.

Fizyczny obrys samochodu wynosi 5,5 × 1,8 m. Kontakt z granicą sprawdza środek i cztery narożniki. Powiększony symbol graficzny 9 × 3 jednostki służy czytelności i nie powiększa obrysu kolizji.

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

AI śledzi krótką trajektorię wzdłuż osi toru zamiast celować o całe checkpointy naprzód przez wąskie zakręty. Sieć wnosi ograniczoną korektę skrętu. Progi sensorów zależą od szerokości drogi, a plan hamowania jest konserwatywną heurystyką, nie dokładnym solverem maksymalnego tempa.

Tankowanie ma przepływ 28 kg/s, cel 110 kg i czas co najmniej 3,2 s. Końcowy krok nalicza tylko pozostały czas tankowania. Postój wlicza się do czasu okrążenia i wyścigu. Początek postoju następuje przy zaliczeniu mety po zgłoszeniu zjazdu; brak fizycznego przejazdu aleją serwisową pozostaje uproszczeniem gry.

## Ograniczenia

Brak kontaktów samochód–samochód, impulsów zderzeń z barierą, modelu zawieszenia, temperatury i zużycia opon, skrzyni biegów, wiatru i map aero. Przekroczenie granicy wyklucza samochód. Model nie był kalibrowany względem danych konkretnego bolidu F1. Dawne czasy okrążeń i wagi AI nie są porównywalne z wynikami po zmianie fizyki oraz szerokości toru; zalecany jest nowy trening.

## Weryfikacja

`npm test` sprawdza limity sił, hamowanie od spoczynku i w obu kierunkach, telemetrię, jazdę bokiem, brak paliwa, tankowanie i zegary, skalę, obrys oraz ukończenie okrążeń GP przez AI. Test workera z kontrolowanym zegarem sprawdza 1× przy tickerach 16 ms i 20 ms oraz pauzę. `npm run audit:physics` wypisuje wyniki numeryczne; `npm run build` sprawdza TypeScript i bundlowanie.

`AUDIT_PHYSICS.md` zachowuje dowody stanu sprzed napraw. Poprawiono osiem opisanych tam problemów i akumulator czasu; pełna dynamika yaw, zderzenia i fizyczna aleja serwisowa pozostają ograniczeniami modelu.
