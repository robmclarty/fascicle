/**
 * Five vendored SWE-bench Verified instances, used as the smoke set.
 *
 * The full set lives at https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified.
 * For real runs, swap `SMOKE_INSTANCES` with a loader that pulls the parquet
 * dataset; this fixture exists so the harness type-checks and exercises the
 * sandbox/judge seams without a HuggingFace dep at smoke-test time.
 *
 * Problem statements are truncated for readability. Test patch bodies are
 * empty in this fixture; the real dataset carries them and `judge_patch_applies`
 * will validate against the agent's emitted patch regardless.
 */

import type { SweBenchInstance } from './types.js'

export const SMOKE_INSTANCES: ReadonlyArray<SweBenchInstance> = [
  {
    instance_id: 'astropy__astropy-12907',
    repo: 'astropy/astropy',
    base_commit: 'd16bfe05a744909de4b27f5875fe0d4ed41ce607',
    problem_statement:
      'Modeling `separability_matrix` does not compute separability correctly for nested CompoundModels.',
    hints_text: '',
    test_patch: '',
    version: '4.3',
    fail_to_pass: ['astropy/modeling/tests/test_separable.py::test_separable[compound_model6-result6]'],
    pass_to_pass: ['astropy/modeling/tests/test_separable.py::test_separable[compound_model0-result0]'],
  },
  {
    instance_id: 'django__django-11099',
    repo: 'django/django',
    base_commit: 'd26b2424437dabeeca94d7900b37d2df4410da0c',
    problem_statement:
      'UsernameValidator allows trailing newline in usernames. Regex used in ASCIIUsernameValidator and UnicodeUsernameValidator should not allow trailing newlines.',
    hints_text: '',
    test_patch: '',
    version: '3.0',
    fail_to_pass: ['tests/auth_tests/test_validators.py::UsernameValidatorsTests::test_unicode_validator'],
    pass_to_pass: ['tests/auth_tests/test_validators.py::UsernameValidatorsTests::test_ascii_validator'],
  },
  {
    instance_id: 'sympy__sympy-20639',
    repo: 'sympy/sympy',
    base_commit: 'eb926a1d0c1158bf43f01eaf673dc84416b5ebb1',
    problem_statement:
      'Inaccurate rendering of pi**(1/E): pretty printer shows it as the cube root of pi.',
    hints_text: '',
    test_patch: '',
    version: '1.8',
    fail_to_pass: ['sympy/printing/pretty/tests/test_pretty.py::test_PrettyPoly'],
    pass_to_pass: ['sympy/printing/pretty/tests/test_pretty.py::test_pretty_basic'],
  },
  {
    instance_id: 'scikit-learn__scikit-learn-14894',
    repo: 'scikit-learn/scikit-learn',
    base_commit: 'fdbaa58acbead5a254f2e6d597dc1ab3b947f4c6',
    problem_statement:
      'ZeroDivisionError in _sparse_fit for SVM with empty support_vectors_.',
    hints_text: '',
    test_patch: '',
    version: '0.22',
    fail_to_pass: ['sklearn/svm/tests/test_svm.py::test_sparse_fit_support_vectors_empty'],
    pass_to_pass: ['sklearn/svm/tests/test_svm.py::test_libsvm_iris'],
  },
  {
    instance_id: 'matplotlib__matplotlib-23314',
    repo: 'matplotlib/matplotlib',
    base_commit: '97fc1154992f64cfb2f86321155a7404efeb2d8a',
    problem_statement:
      "set_visible() on 3D projections does not work: Axes3D.set_visible(False) doesn't hide the axes.",
    hints_text: '',
    test_patch: '',
    version: '3.5',
    fail_to_pass: ['lib/mpl_toolkits/tests/test_mplot3d.py::test_axes3d_set_visible'],
    pass_to_pass: ['lib/mpl_toolkits/tests/test_mplot3d.py::test_aspect_equal_error'],
  },
]
