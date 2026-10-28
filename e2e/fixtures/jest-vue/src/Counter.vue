<template>
  <button @click="increment">
    {{ label }}: {{ count }}
  </button>
</template>

<script>
import { shout } from './text';

export default {
  props: { name: String },
  data() {
    return { count: 0 };
  },
  computed: {
    label() {
      return shout(this.name);
    },
  },
  methods: {
    increment() {
      this.count += 1;
    },
  },
};
</script>
