.PHONY: serve push brave

serve:
	python -m http.server 8000

push:
	git add .
	git commit -m "update"
	git push

brave:
	xdg-open https://hjlgood.github.io/my_dashboard/
