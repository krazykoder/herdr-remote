.PHONY: relay-install relay-run relay-plugin ios-build build deploy-web

relay-install:
	pip install -r relay/requirements.txt

relay-run:
	python3 relay/herdr_relay.py

relay-plugin:
	herdr plugin link relay/

ios-build:
	cd herdi-ios && swift build

# Inlines web/src/*.js into web/index.html, writing the single-file bundle to web/dist/.
build:
	python3 scripts/build.py

# Publishes web/dist/ to https://eagerkoder.github.io/mini/ using your own git credentials.
deploy-web: build
	./web/deploy.sh
