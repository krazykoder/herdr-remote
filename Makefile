.PHONY: relay-install relay-run relay-plugin ios-build deploy-web build

build:
	python3 scripts/build.py

# Publishes web/dist/ to https://eagerkoder.github.io/mini/ using your own git credentials.
deploy-web: build
	./web/deploy.sh
