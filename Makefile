# Region is pinned: the shell's AWS_REGION can silently override AWS_DEFAULT_REGION for CLI calls.
export AWS_REGION ?= us-east-1
export AWS_DEFAULT_REGION ?= us-east-1
export CDK_DEFAULT_ACCOUNT ?= $(shell aws sts get-caller-identity --query Account --output text)

PY = .venv/bin/python

install:
	cd cdk && npm install
	test -d .venv || python3 -m venv .venv
	.venv/bin/pip install --quiet boto3

deploy: install
	cd cdk && npx cdk deploy --require-approval never --outputs-file cdk.outputs.json

scenarios:
	$(PY) demo/run.py scenarios | tee docs/transcript.txt

test-gates:
	$(PY) demo/run.py gates | tee docs/gate-transcript.txt

lint-policies:
	python3 demo/lint_policies.py

destroy:
	cd cdk && npx cdk destroy --force

.PHONY: install deploy scenarios test-gates lint-policies destroy
