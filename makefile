.PHONY: serve push

serve:
	python -m http.server 8000

push:
	git add .
	git commit -m "update"
	git push
