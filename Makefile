.PHONY: relay-install relay-run relay-plugin ios-build deploy-web

relay-install:
	pip install -r relay/requirements.txt

relay-run:
	python3 relay/herdi_relay.py

relay-plugin:
	herdr plugin link relay/

ios-build:
	cd herdi-ios && swift build

# Publishes web/ to https://eagerkoder.github.io/mini/ using your own git credentials.
deploy-web:
	./web/deploy.sh
