# Instalacja BirdsCounter na Androidzie

BirdsCounter nie jest w Sklepie Google Play. Instaluje się go z pliku APK pobranego ze strony wydań na GitHubie.
**Tryb deweloperski nie jest potrzebny**: wystarczy raz pozwolić przeglądarce (albo menedżerowi plików) na
instalowanie aplikacji.

## Wymagania

- Android 7.0 lub nowszy.
- Telefon z 64-bitowym procesorem ARM (arm64). Mają go prawie wszystkie telefony z ostatnich lat.

## 1. Pobierz plik APK

1. Otwórz na telefonie stronę [github.com/qoqosz/BirdsCounter/releases/latest](https://github.com/qoqosz/BirdsCounter/releases/latest).
2. W sekcji **Assets** stuknij plik `BirdsCounter_<wersja>_android_arm64.apk`.
3. Jeśli przeglądarka ostrzeże, że plik może być szkodliwy, wybierz **Pobierz mimo to**. Chrome pokazuje to
   ostrzeżenie przy każdym pliku APK spoza Sklepu Play.

## 2. Zezwól na instalowanie aplikacji z tego źródła

Przy pierwszej instalacji Android zablokuje plik i pokaże komunikat w rodzaju *„Ze względów bezpieczeństwa
telefon nie może instalować nieznanych aplikacji z tego źródła”*.

1. Stuknij **Ustawienia** w tym komunikacie.
2. Włącz przełącznik **Zezwalaj z tego źródła** (dla Chrome, Firefoxa albo aplikacji Pliki, zależnie od tego, czym
   otwierasz plik).
3. Wróć przyciskiem Wstecz. Instalator otworzy się ponownie.

Jeśli komunikat się nie pojawił, to samo ustawienie znajdziesz ręcznie. Jego nazwa i miejsce zależą od producenta:

- **Czysty Android, Pixel:** *Ustawienia → Aplikacje → Dostęp specjalny → Instalowanie nieznanych aplikacji* →
  wybierz przeglądarkę → *Zezwalaj z tego źródła*.
- **Samsung:** *Ustawienia → Aplikacje → ⋮ → Dostęp specjalny → Instalowanie nieznanych aplikacji*.
- **Xiaomi/Redmi/POCO:** *Ustawienia → Ochrona prywatności → Dostęp specjalny → Instaluj nieznane aplikacje*.
- **Android 7:** *Ustawienia → Zabezpieczenia → Nieznane źródła* (jeden przełącznik dla całego telefonu).

Najłatwiej wpisać w wyszukiwarkę ustawień słowo **„nieznane”**.

## 3. Zainstaluj aplikację

1. Otwórz pobrany plik: z powiadomienia o zakończonym pobieraniu albo z folderu **Pobrane** w aplikacji Pliki.
2. Stuknij **Zainstaluj**.
3. Jeśli **Google Play Protect** zapyta o aplikację, której nie zna, wybierz **Więcej szczegółów → Zainstaluj mimo
   to**. Jeśli zaproponuje przeskanowanie aplikacji, możesz się zgodzić albo odmówić, instalacja przebiegnie tak samo.
4. Po instalacji stuknij **Otwórz**. Ikona BirdsCounter pojawi się też na liście aplikacji.

Na koniec możesz wyłączyć z powrotem **Zezwalaj z tego źródła** dla przeglądarki. Zainstalowana aplikacja będzie
działać dalej.

## Aktualizacja

Pobierz nowszy plik APK i zainstaluj go tak samo, przez stary. Historia zostanie zachowana. Nie odinstalowuj
poprzedniej wersji, bo usunie to historię liczeń.

## Problemy

- **„Aplikacja nie została zainstalowana”** albo **„Pakiet wydaje się nieprawidłowy”**: plik nie pobrał się do końca
  albo telefon nie ma procesora arm64. Pobierz plik jeszcze raz. Jeśli to nie pomoże, użyj
  [wersji w przeglądarce](https://qoqosz.github.io/BirdsCounter/), która działa na każdym telefonie.
- **„Konflikt z istniejącym pakietem”**: na telefonie jest wersja podpisana innym kluczem (na przykład zbudowana
  samodzielnie). Odinstaluj ją i zainstaluj ponownie.
- **Nie widać przycisku Zainstaluj**: niektóre nakładki zasłaniają go, gdy na ekranie jest dymek innej aplikacji
  (np. Messengera). Zamknij dymek i otwórz plik jeszcze raz.

## Bez instalacji

[Wersja w przeglądarce](https://qoqosz.github.io/BirdsCounter/) liczy ptaki tak samo i nie wymaga instalacji. Zdjęcia
nie opuszczają telefonu.
