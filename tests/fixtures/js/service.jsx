function Button(props) {
  return <button>{props.label}</button>;
}

class Calculator {
  constructor(initial = 0) {
    this.value = initial;
  }

  add(n) {
    this.value += n;
    return this.value;
  }
}
